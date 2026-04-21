# Codec Reference

@o11ykit/metricsdb ships three value compression codecs, selected automatically
per-chunk at encode time. All run as Rust→WASM with a TypeScript fallback.

## Codec Pipeline

```
raw f64 values (16 B/pt)
  │
  ├── ALP path (default for encodeValuesALP*)
  │     │
  │     ├── is counter? ─── yes ──► try Delta-ALP
  │     │                              │
  │     │                        smaller? ──► emit Delta-ALP
  │     │                              │ no
  │     │                              ▼
  │     └── plain ALP ◄───────────── fallback
  │
  └── XOR-delta path (encodeValues)
        └── Gorilla bit-packing
```

The ALP-family encoder is the primary path for column-oriented storage.
XOR-delta is used for the chunk-oriented legacy path and as a baseline.

## 1. XOR-Delta (Gorilla)

**Reference:** Pelkonen et al., "Gorilla: A Fast, Scalable, In-Memory
Time Series Database," VLDB 2015.

**Mechanism:** XOR consecutive values; encode leading/trailing zero runs.
Timestamps use delta-of-delta with a 4-tier prefix code (7, 9, 12 bits
or raw 32-bit).

**Wire format:**

```
Header:
  [count (u16 BE)]
  [first_ts (i64 BE)]
  [first_val (f64 BE)]
Payload:
  Per sample: delta-of-delta timestamp bits + XOR value bits
```

**When it wins:** High-entropy or floating-point data where values don't
map cleanly to integers.

**Typical compression:**

| Pattern | B/pt |
|---------|------|
| constant gauge | 0.28 |
| slow gauge | 6.89 |
| monotonic counter | 2.29 |
| spiky latency | 7.37 |
| high entropy | 6.64 |

## 2. ALP (Adaptive Lossless floating-Point)

**Reference:** Afroozeh et al., "ALP: Adaptive Lossless floating-Point
Compression," SIGMOD 2024.

**Mechanism:** Three-step pipeline:
1. **Exponent scan** — find best `e` so `val × 10^e` round-trips to an integer
2. **Frame-of-Reference** — subtract `min_int`, compute bit-width
3. **Bit-pack** — pack offsets at the computed width; store exceptions as raw f64

**Wire format (14-byte header + payload):**

```
Header (14 B):
  [0–1]   count        (u16 BE)
  [2]     exponent     (u8, 0–18)
  [3]     bit_width    (u8, 0–64)
  [4–11]  min_int      (i64 BE, frame of reference)
  [12–13] exc_count    (u16 BE)
Payload:
  bit-packed offsets    (⌈count × bit_width / 8⌉ bytes)
  exception positions   (exc_count × u16 BE)
  exception raw values  (exc_count × f64 BE)
```

**When it wins:** Series where most samples are integer-valued or have
few significant decimal digits: gauges, counters, rates, percentages.

**Typical compression (640-sample chunks):**

| Pattern | Bytes | B/pt |
|---------|-------|------|
| constant gauge | 14 | 0.02 |
| slow gauge | 894 | 1.40 |
| monotonic counter | 1,374 | 2.15 |
| high entropy | 5,424 | 8.48 |

Constants collapse to the 14-byte header alone (bw=0, no exceptions).

## 3. Delta-ALP

**Motivation:** Monotonic counters have small increments but a large total
range. Plain ALP sees the full value range and allocates wide bit-packing
(e.g. bw=17 for a counter spanning 0–100 K). Differencing first reduces
the range to the increment distribution, dropping bit-width to 6–8 bits.

**Detection criteria (all must be true):**
- `reset_count == 0` — no value decreases in the chunk
- `first_value < last_value` — actually increasing (excludes constants)
- All values are integer-valued f64 (`v == (v as i64) as f64`)

Integer-valued is required because f64 subtraction is exact only when
both operands and the result are representable integers (magnitude < 2^53).

**Wire format:**

```
[0xDA]                    — tag byte (Delta-ALP marker)
[base_f64 (8 B BE)]      — first value, raw f64 bits
[ALP block (variable)]   — ALP-encoded deltas (n−1 values)
```

The tag byte 0xDA (218) is safe: regular ALP header byte 0 is
`count >> 8`, and count ≤ 2048 → byte 0 ≤ 8. No collision possible.

**Decoder:** Reads base, ALP-decodes the deltas, reconstructs values via
prefix sum. Range decode (`decode_values_alp_range`) must still compute
the full prefix sum up to the requested start index — delta-ALP trades
random-access for better compression.

**When it wins:** Monotonic integer counters with moderate increments
(typical of request counts, bytes transferred, event totals).

**Compression results (640-sample chunks):**

| Pattern | Plain ALP | Delta-ALP | Improvement |
|---------|-----------|-----------|-------------|
| monotonic counter | 1,374 B (2.15 B/pt) | 662 B (1.03 B/pt) | 2.08× |
| counter + 40% idle | 974 B (1.52 B/pt) | 343 B (0.54 B/pt) | 2.84× |
| constant gauge | 14 B | 14 B | — (not triggered) |
| slow gauge | 894 B | 894 B | — (not triggered) |
| high entropy | 5,424 B | 5,424 B | — (not triggered) |

Counters with idle periods (many zero-deltas) compress even better
because ALP can bit-pack the sparse deltas at very low bit-width.

## Engine-Level Impact

The engine benchmark mixes series types to model a realistic workload:
20% constants, 30% counters (40% idle), 30% gauges, 20% high-variance.

| Backend | B/pt (before delta-ALP) | B/pt (after) | Δ |
|---------|------------------------|--------------|---|
| column-alp-full | ~8.6 | ~8.0 | −7% |
| column-alp-range | ~8.6 | ~8.0 | −7% |

Delta-ALP improves the aggregate by ~7% on the mixed workload, with
no regression on any pattern. The improvement is concentrated in the
30% of series that are counter-shaped.

## Codec Selection Logic

Selection is automatic inside `encodeValuesALPWithStats` and
`encodeBatchValuesALPWithStats`:

1. Compute block stats (min, max, first, last, reset_count).
2. Call `is_delta_alp_candidate(vals, reset_count)`.
3. If candidate: encode both delta-ALP and plain ALP, keep smaller.
4. If not candidate: plain ALP only.

The "try both, keep smaller" approach adds ~0.5 µs per chunk for
counter series (one extra ALP encode of n−1 deltas) but guarantees
no regression: if delta-ALP is larger, it's discarded silently.

## Adding a New Codec

To add a fourth codec variant:

1. Choose a tag byte > 8 that doesn't collide with existing tags
   (0xDA = delta-ALP). Document why the tag is safe.
2. Implement `new_codec_encode_inner` and `new_codec_decode_inner`
   following the existing pattern.
3. Add detection in `encodeValuesALPWithStats` (or create a new
   top-level dispatcher if the codec isn't ALP-derived).
4. Add dispatch in `decode_values_alp_inner` and
   `decode_values_alp_range` (first-byte check).
5. Add a targeted bench test (see `bench/delta-alp-test.mjs`).
6. Run `node bench/run.mjs engine` to verify no regression on all
   6 backends.
