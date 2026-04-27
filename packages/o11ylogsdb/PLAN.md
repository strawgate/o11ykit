# o11ylogsdb — Execution Plan

## What This Is

A browser-native (also Node, Bun, Edge) logs database for OpenTelemetry
data. Ingests OTLP logs (protobuf or JSON), stores them in a compressed
columnar format, serves search + filter + tail queries — no backend.

Sister to `o11ytsdb`. Where `o11ytsdb` does metrics (XOR-delta + ALP +
Delta-ALP, 0.04–7 B/sample), `o11ylogsdb` does logs (Drain + FSST + ALP +
binary fuse + Roaring-lite, target ~13.5 B/log on a typical mixed-source
chunk).

**Storage efficiency is the product.** The 20× target (raw OTLP/JSON →
compressed in-memory) is the gating metric. Every PR ships
bytes-per-log numbers on the public log corpora used in `bench/`.

Architectural assumptions validated against benchmarks under `bench/`.
The condensed findings record — what we measured, what we ship, what
we refuted — lives in [`dev-docs/findings.md`](./dev-docs/findings.md)
and [`dev-docs/techniques.md`](./dev-docs/techniques.md).

---

## Priority Stack (non-negotiable ordering)

1. **Smallest storage footprint** — 20× over raw OTLP/JSON minimum,
   stretch goal 50× on heavily templated workloads. Target
   ~13.5 B/log on a mixed-source chunk.
2. **Fastest query** — sub-5 ms p50 for predicate match over 1 M logs
   in browser (with skip indexes).
3. **Fastest ingest** — sustain 100 K logs/sec WASM, 20 K logs/sec TS.

When these conflict, storage wins. A change that saves 10 ms of query
latency at the cost of 20% more bytes/log gets rejected.

---

## Storage Efficiency Target

This is the matrix that determines whether we hit 20×. Numbers are
amortized B/log on a representative chunk of 1024 logs from a typical
mixed-source workload **from measurements**: ~61% templated text, ~39%
KVList (structured-JSON), <1% free-text.

| Column | Codec | B/log |
|---|---|---|
| `time_unix_nano` | delta-of-delta + ZigZag + FastLanes BP | 0.2 |
| `observed_time_unix_nano` | delta from `time_unix_nano`, sparse | 0.05 |
| `severity_number` | 5-bit dict + RLE | 0.02 |
| `severity_text` | per-chunk dict | 0.02 |
| `body` (templated, ~61%) | `(template_id, vars[])` via Drain | 2.5 |
| `body` (KVList, ~39%) | recursive flatten → per-key columns; high-cardinality identifier columns routed to BF16+raw-bytes path | 5.0 |
| `body` (free-text, <1%) | OnPair (small fragments) or FSST + ZSTD-3 | ~0.05 |
| `attributes` (lazy columnar) | per-key column, codec by type | 6.0 |
| `resource` | hoisted to chunk header | 0 |
| `scope` | per-chunk dict | 0.05 |
| `trace_id`, `span_id` | per-chunk dict + binary fuse 16 | 1.5 |
| `flags`, `dropped_attributes_count` | RLE | 0.05 |
| `event_name` | per-chunk dict | 0.5 |
| **Total body+attrs+meta** | | **~16.0 B/log** |
| Index overhead (BF8/BF16, zone map, Roaring) | | ~1.1 |
| **Grand total** | | **~17.1 B/log** |

That is **~24× over raw OTLP/JSON** on a KVList-heavy workload
(measurement validated the KVList budget at ~5 B/log per body once
high-cardinality identifier columns are routed to a BF16+raw-bytes
path; lower-cardinality KVList bodies hit the original 1.4 B/log
target). On templated-text-heavy workloads, the
aggregate drops to ~12 B/log → 35–60×. The 20× hard floor holds across
both shapes; KVList-heavy workloads are tighter.

**Per-corpus targets validated by measurement** (Drain+ZSTD-19 alone,
before our typed-column stack):

| Corpus | Drain+ZSTD-19 floor (B/log) | ratio vs OTLP/JSON |
|---|--:|--:|
| Apache | 3.12 | 63.20× |
| Linux | 4.44 | 44.39× |
| BGL | 6.64 | 35.49× |
| HDFS | 7.72 | 31.62× |
| OpenStack | 18.67 | 21.74× |

Our typed-column stack (with random-access decode) must match or beat
these floors. Per-corpus B/log gates in M4 are set against this table.

The four high-impact techniques carrying most of the win:

1. **Drain template extraction** as a *structure* primitive (not a
   compression primitive — the public log corpus measurements show Drain only adds 1–8%
   compression over plain ZSTD-19 on text). What Drain buys is
   **random-access decode and predicate pushdown** on the body
   column, which whole-archive compression schemes don't provide.
2. **Per-stream chunking + resource hoisting**. Modest compression
   bonus (measured **1.13–1.28×** on public log-corpus samples,
   not the 1.5–2× originally projected; the win shrinks as the
   compressor's window grows). The primary value is the *query
   model*: per-stream chunks are the right unit for the stream label
   index, filter pushdown, and the resource-as-chunk-metadata layout
   that makes `service.name = "X"` a header check instead of a row
   scan.
3. **FSST** for residual strings (variable values, attribute values).
   ~2–3× over raw on short strings; <8 KB symbol table; SIMD decode.
   measurement showed **4.93 GB/s decode in WASM** — 5× over the
   ~1 GB/s target.
4. **ALP / Delta-ALP** on numeric attribute columns — already shipping
   in `o11ytsdb`.

Measurements **invalidated** "trained ZSTD dictionaries per
stream" as a useful technique on log corpora at our chunk
granularity — the 16 KB-trained ZSTD-19 dict ties or *loses* on 5 of
5 text corpora and 3 of 4 string corpora. Removed from M5 and from
bleeding-edge.

---

## The Dual Implementation Protocol

Every hot-path module has two implementations: TypeScript and Rust→WASM.
They serve as mutual oracles. Same protocol as `o11ytsdb/PLAN.md`:

1. Both must exist before merge.
2. Cross-validate all test vectors. TS encode → Rust decode and vice
   versa. Bit-exact, or it's a bug.
3. Benchmark both on every PR.
4. Ship the winner — Rust WASM as the fast path, TS as the
   always-available fallback. Auto-detect at runtime.
5. No vendor names in source. Algorithms have papers, not brands.
   Call it "log template extraction," not "Drain." Call it "static
   symbol table string compression," not "FSST." Code reads like a
   textbook, not a changelog.

### Where TS-only is acceptable

The Drain template matcher and FSST decoder are painful in pure TS
(constant-factor cost of bit twiddling and short-string allocation
hits us hard). For `o11ylogsdb` specifically:

- **Ingest path**: WASM required. The TS fallback exists only for
  read-only query against previously-built chunks.
- **Query path**: TS-only must work end-to-end (decode + filter +
  scan).

This is a relaxation from `o11ytsdb`'s "TS works for everything"
stance, and it's deliberate.

---

## WASM Binary Strategy

**One Rust workspace, multiple thin binding crates, one WASM artifact
per engine.** Never a single mega-binary that must be loaded by every
engine.

### Why separate binaries

- Each engine ships only the codecs it actually uses. `o11ytsdb`
  doesn't need Drain or FSST. `o11ytracesdb` won't need Drain.
- Tree-shaking via `wasm-opt`/`wasm-strip` works per-crate; cross-crate
  it requires LTO and is fragile.
- Independent versioning: a Drain bug fix shipping `o11ylogsdb` v1.2.3
  must not force a `o11ytsdb` re-publish.
- Failure isolation: a bad codec push doesn't break unrelated engines.
- Clear ownership: each engine owns its `lib.rs` and `extern "C"` ABI.

### Layout

```
packages/
├── o11y-codec-rt/                    ← shared workspace (NEW)
│   ├── Cargo.toml                    (workspace manifest)
│   ├── core/                         ← BitReader/Writer, FastLanes BP,
│   │                                   dict builder. #![no_std].
│   ├── xor-delta/                    ← Gorilla XOR-delta (lifted from
│   │                                   o11ytsdb/rust/)
│   ├── alp/                          ← ALP / Delta-ALP (lifted)
│   ├── fsst/                         ← FSST encode + SIMD decode (NEW)
│   ├── drain/                        ← Streaming log template
│   │                                   extractor (NEW, in-house)
│   ├── roaring-lite/                 ← Array+bitmap container only,
│   │                                   no run container (NEW)
│   ├── binary-fuse/                  ← BF8 + BF16 (NEW)
│   └── fastlanes-bp/                 ← Already implicit in alp/
│                                       — promote to its own crate
│
├── o11ytsdb/                         (existing)
│   └── rust/                         ← thin binding crate
│       Cargo deps: core, xor-delta, alp, fastlanes-bp
│       Builds → o11ytsdb-rust.wasm   (~18 KB gz, current measured)
│
└── o11ylogsdb/                       (NEW)
    └── rust/                         ← thin binding crate
        Cargo deps: core, alp, fsst, drain, roaring-lite,
                    binary-fuse, fastlanes-bp
        Builds → o11ylogsdb-rust.wasm (~21 KB gz measured, <25 KB target)
```

### Future: o11ytracesdb-rust.wasm

```
└── o11ytracesdb/rust/
    Cargo deps: core, alp, fsst, fastlanes-bp,
                roaring-lite, binary-fuse,
                span-id-dict (NEW, traces-specific)
    Builds → o11ytracesdb-rust.wasm  (<25 KB gz target)
```

### Migration of existing o11ytsdb/rust/

M0 deliverable: extract `xor-delta`, `alp`, and `fastlanes-bp` from
`packages/o11ytsdb/rust/src/` into `packages/o11y-codec-rt/`. Reduce
`o11ytsdb/rust/` to a binding crate. Required cross-validation:
`o11ytsdb-rust.wasm` byte size and benchmark numbers must not regress.

### WASM size budget

Revised from initial PLAN draft after re-measuring the
shipped artifacts and built the candidate codec crates. Original
budget was based on a stale "1.5 KB gzipped" o11ytsdb number that was
the M1-only baseline; the current shipped binary is 18 KB gzipped.

| Engine | Raw target | Gzipped target | Notes |
|---|---|---|---|
| `o11ytsdb-rust.wasm` | 25 KB | **18 KB** (current) | Re-measured. M1-only ship was 1.5 KB; ALP / Delta-ALP added since. |
| `o11ylogsdb-rust.wasm` | 50 KB | **<25 KB** | Combined cdylib of FSST + Roaring-lite + binary-fuse + in-house Drain currently builds to 21 KB gz; budget includes headroom. |
| `o11ytracesdb-rust.wasm` (future) | 50 KB | <25 KB | Similar codec stack minus Drain. |

Per-engine budget tracked manually for now (each codec-workspace PR
reports its size delta in the PR body). A proper CI gate is a
follow-up.

Measurements validated:

- `wasm-opt -Oz` and `wasm-strip` are **no-ops** on top of Cargo's
  size profile (`opt-level=z`, `lto=true`, `codegen-units=1`,
  `strip=true`, `panic="abort"`). Don't waste a build step on them
  unless the profile changes.
- **The available Rust crate of the Drain algorithm uses a C regex
  library** that doesn't build for `wasm32-unknown-unknown` without a
  C sysroot. We write Drain in-house. A 200-LoC port builds to 6.8 KB
  gz; see [`dev-docs/drain-prototype.md`](./dev-docs/drain-prototype.md).
- **FSST** (the published static-symbol-table string codec) builds
  unchanged to 15 KB gz. Fork-and-trim candidates (drop encoder,
  simplify symbol-table builder) project to ~8 KB gz; do this in M1
  only if the combined budget is tight.

---

## Module Map

Dependency order. Each module has a benchmark gate that must pass
before the next module starts.

```
M0  Codec Workspace Migration         ← extract shared codecs from o11ytsdb
 │
M1  FSST + Bit I/O extensions          ── M2  Drain Template Extractor
 │                                          │
 │                                          │
M3  Per-Stream Chunk Format ──────────────┘
 │
M4  Per-Column Codec Dispatch
 │
M5  OTLP Logs Ingest Pipeline
 │
M6  Indexes (zone map, binary fuse, Roaring-lite)
 │
M7  Streaming Query Executor + Builder API
 │
M8  Worker Isolation + Public API
```

### M0: Codec Workspace Migration

Extract shared codecs from `packages/o11ytsdb/rust/` into the new
`packages/o11y-codec-rt/` workspace. Reduce `o11ytsdb/rust/` to a thin
binding crate.

**Status: complete.** `core/`, `xor-delta/`, and full `alp/`
(including encode/decode bodies) extracted. `o11ytsdb/rust/`'s
`gorilla.rs`, `timestamp.rs`, and `delta_alp.rs` are thin extern "C"
shims; `alp.rs` and `alp_exc.rs` are deleted (pure logic moved).
`fastlanes-bp` is not a separate extraction — bit-packing primitives
already live in `core/` (`extract_packed`, `BitWriter::write_bits`).

**Deliverables:**
- `packages/o11y-codec-rt/Cargo.toml` — workspace manifest. ✅
- `packages/o11y-codec-rt/core/` — `BitWriter`, `BitReader`, zigzag,
  bit-width helpers, packed-array extraction. `#![no_std]`. ✅
- `packages/o11y-codec-rt/xor-delta/` — combined chunk encode/decode,
  values-only, timestamps-only, block stats. Pure-Rust slice API. ✅
- `packages/o11y-codec-rt/alp/` — full ALP / Delta-ALP codec:
  utilities, constants, `alp_encode`, `alp_decode_regular`,
  `alp_find_exponent`, `decode_exceptions`, `delta_alp_encode`,
  `delta_alp_decode_range`, `decode_values_alp`, dispatcher.
  Scratch buffers stack-allocated (worst case ~50 KB on the wasm32
  1 MB stack). ✅
- `packages/o11ytsdb/rust/Cargo.toml` depends on `core` + `xor-delta`
  + `alp`. ✅
- `packages/o11ytsdb/rust/src/{gorilla,timestamp,delta_alp}.rs` reduced
  to thin extern "C" shims around the workspace crates. ✅
- `packages/o11ytsdb/rust/src/{alp,alp_exc}.rs` deleted. ✅

**Benchmark gate:** Each migration PR verifies size + perf parity.

| Metric | Target |
|---|---|
| `o11ytsdb-rust.wasm` size delta | ≤ 0 bytes |
| Encode/decode throughput | within ±2% of pre-migration |
| Cross-validation tests | bit-exact on all 10 existing vectors |

Cumulative size delta on `o11ytsdb-rust.wasm`:

| Step | Raw | Gz | Cumulative raw | Cumulative gz |
|------|-----|----|---------------:|--------------:|
| Pre-M0 baseline | 2,143,340 | 18,144 | — | — |
| `core/` extraction | +316 | +270 | +0.015% | +1.49% |
| `xor-delta/` extraction | -120 | -2 | +0.009% | +1.48% |
| `alp/` utilities extraction | 0 | -21 | +0.010% | +1.37% |
| `alp/` body extraction | 0 | +20 | +0.010% | +1.46% |

The `xor-delta/` extraction slightly *shrunk* the binary because the
4-tier delta-of-delta prefix coder lifted into shared helpers
(`write_dod` / `read_dod`) consolidates code that used to be
duplicated between `gorilla.rs` and `timestamp.rs`. The architectural
payoff (one shared codec crate `o11ylogsdb` and `o11ytsdb` both
depend on) was already worth the ~1.5% gz cost from `core/`; xor-
delta makes that negligible.

### M1: FSST + Bit I/O Extensions

Add FSST encode + SIMD decode to the shared workspace. Add binary fuse
8/16 builders. Add Roaring-lite (array + bitmap container only).
Optionally add OnPair as a body-specific codec.

**Deliverables:**
- `o11y-codec-rt/fsst/` — pure-Rust FSST (static symbol-table string
  codec from the published paper). Symbol table builder, encode,
  branch-free SIMD decode via terminator byte. The reference Rust
  impl measures 15 KB gz / 4.93 GB/s decode in WASM unchanged; trim
  for size as needed.
- `o11y-codec-rt/binary-fuse/` — BF8 (9 bits/key, 0.39% FPR) and
  BF16 (18 bits/key, 0.0015% FPR). Static / immutable.
- `o11y-codec-rt/roaring-lite/` — minimal Roaring32 (sorted array
  container under 4096 cardinality, bitmap container ≥ 4096; no run
  container). The published full-feature Rust crate is 11 KB gz; our
  minimal subset re-implements smaller.
- *(optional, on the FSST budget)* `o11y-codec-rt/onpair/` — Byte-pair
  encoding string codec. Measured 4.49× ratio vs FSST's 1.54× on
  free-text body fragments and 9.6 GB/s decode vs FSST's 1.5 GB/s
  for per-row decode. Add only if real workloads emerge with
  non-trivial free-text share.
- TS reference implementations.
- Cross-validation vectors against the published reference
  implementations (FSST, xor-filter, Roaring32).

**Benchmark gate:**

| Metric | TS target | Rust target | Notes |
|---|---|---|---|
| FSST encode | ≥10 MB/s | ≥200 MB/s | URL/host/path corpus |
| FSST decode | ≥50 MB/s | ≥800 MB/s | WASM SIMD |
| FSST ratio | ≥2.0× | ≥2.0× | vs raw on URL corpus |
| BF8 build | ≥100 K keys/s | ≥2 M keys/s | |
| BF8 query | <100 ns | <30 ns | |
| Roaring AND (1 M ∩ 1 M) | <2 ms | <500 µs | |
| Added .wasm size | — | <10 KB raw | Gzipped: <4 KB |

### M2: Drain Template Extractor

Streaming log parser, fixed-depth tree, similarity-threshold matching.
Per-stream state. The body-shape classifier sits on top.

**Status: prototype validated.** The in-house Rust Drain port at
`rust-prototype/drain/` produces bit-identical clusterings to the
published Python reference (ARI = 1.0000 on five public log corpora)
at 6.7 KB gz / 0.9–3.3 M logs/s native. M2 is the graduation work:
move that crate into `packages/o11y-codec-rt/drain/` and add the
remaining wrapping (TS reference, masker, persistence). See
[`dev-docs/drain-prototype.md`](./dev-docs/drain-prototype.md).

**Deliverables:**
- `o11y-codec-rt/drain/` — graduated from `rust-prototype/drain/`.
  Default depth 4, `sim_th` 0.4, `max_children` 100. (Validated.)
- Configurable mask layer (number / IP / hex prefix) — pure Rust, no
  C dependencies. Sits in front of the parser, called from the host.
  *Not in the prototype; add during graduation.*
- Persistable state (chunk header) — snapshot/restore. *Not in the
  prototype; M3 concern, but ABI accommodates it.*
- `body`-shape classifier: try Drain → if match, templated; else
  probe for JSON/KVList; else free-text.
- TS reference implementation (already at `src/drain.ts`, integrated
  via `DrainChunkPolicy` and the columnar policies).
- Cross-validation test vectors against the published Python
  reference on the public log corpus suite.

**Benchmark gate:**

| Metric | TS target | Rust target |
|---|---|---|
| Throughput (large corpus) | ≥30 K logs/s | ≥200 K logs/s |
| Template count (per corpus) | within 1 of reference | within 1 of reference |
| Cross-validation vs reference | ≥0.95 grouping accuracy | ≥0.95 grouping accuracy |
| Added .wasm size | — | <8 KB raw |

### M3: Per-Stream Chunk Format

Serialization of one chunk: header + dictionaries + per-column
payloads.

**Deliverables:**
- `Chunk` struct: 1024 rows default, 5-min time cap.
- Header: schema version, n_logs, time_range, resource (hoisted),
  scope dict, template dict, attribute key dict, FSST symbol table,
  trace_id dict, BF8/BF16 filters, zone map, column offsets.
- `StreamRegistry`: stream_id → resource attributes (interned),
  stream → ordered chunk list. Resource hash collision handled.
- Codec dispatch byte: first byte of each column declares codec
  choice (matches `o11ytsdb` convention).
- TS + Rust serializers.

**Benchmark gate:**

| Metric | Target |
|---|---|
| Chunk header overhead | <512 B per chunk |
| Stream registry per stream | <200 B |
| Serialize 1024-log chunk | <2 ms TS, <0.5 ms Rust |
| Deserialize chunk header | <50 µs |

### M4: Per-Column Codec Dispatch

Wire the codec runtime to the column types. Each column picks its
codec at chunk-build time based on observed data shape.

**Status: M4 thesis validated.** A first-cut `ColumnarDrainPolicy`
(TS only, sidecar NDJSON for non-body columns, length-prefixed binary
body, codec-meta inside compressed payload) beats the NDJSON+ZSTD
baseline on 6/6 public log-corpus samples. Apache hits 3.83 B/log
(1.52× over default). The M4 work from here is per-column codec
specialization (ALP for ints, FSST for strings, BF16 for identifiers).
See [`dev-docs/findings.md`](./dev-docs/findings.md) and
[`dev-docs/techniques.md`](./dev-docs/techniques.md) for the validated
techniques and refuted ones.

**Deliverables:**
- Timestamp column: delta-of-delta + ZigZag + FastLanes BP.
- Severity columns: 5-bit dict + RLE.
- Body/templated: `(template_id, vars[])` with per-template variable
  columns, typed (see `src/codec-typed.ts` for the slot-type set).
- **Body/KVList — first-class path**, not a follow-up. ~39% of real
  OTLP traffic has structured-JSON bodies; they share the per-key
  column dispatch with `attributes`.
- **High-cardinality identifier routing.** A per-row UUID column
  inside a structured-JSON body costs ~19 B/log alone under ZSTD.
  The classifier must detect such columns at chunk close
  (cardinality / N\_rows ≈ 1.0, fixed-length, alphabet matches a
  known ID shape) and route them to the same BF16+raw-bytes path
  that `trace_id` uses. The inverse risk is measured: if these
  columns get Drain-templated by accident, they cost an additional
  +5 B/log instead of saving anything.
- **Skip Drain on KVList body sub-fields by default.** Hierarchical
  Drain (running Drain on `msg`, `req.url`, etc. inside the KVList
  body) saves only ~0.64 B/log aggregate on a structured-JSON corpus,
  while making mistakes on high-cardinality fields very costly. ZSTD
  already captures most of the implicit templating. Apply Drain only
  to top-level string-typed bodies, not recursively to KVList leaves.
- Body/free-text: FSST. <1% of records, so the budget here is small.
  Byte-pair-encoding alternative if the free-text share grows.
- Attributes: lazy column materialization per observed key. Per-key
  codec by value type (FSST / dict+RLE / ALP / FoR). The KVList body
  flatten reuses this machinery.
- Trace\_id: per-chunk dict + BF16. Span\_id: sparse offset.
- Flags / dropped\_attributes\_count / event\_name: RLE / dict.
- **Move codec metadata inside the compressed payload.** Putting the
  per-chunk template dictionary in the *uncompressed* chunk header
  costs ~0.5 B/log of overhead at our chunk size. Per-chunk codec
  meta lives in a length-prefixed region at the head of the codec
  payload, not in the JSON header. This is also a M3 chunk format
  revision.

**Benchmark gate (the big one):**

| Corpus     | Baseline floor (Drain+ZSTD-19) | Current ColumnarDrain | Lossless floor | M4 target |
|------------|-------------------------------:|----------------------:|---------------:|----------:|
| HDFS       |                           7.72 |                 22.50 | ~12 (block IDs)|     ≤17   |
| Apache     |                           3.12 |              **3.83** |             ~3 |     ≤3    |
| BGL        |                           6.64 |                 23.15 | ~12 (µs ts)    |     ≤17   |
| Linux      |                           4.44 |                  6.86 |             ~5 |     ≤5    |
| OpenStack  |                          18.67 |                 22.51 | ~14 (UUIDs)    |     ≤16   |
| OpenSSH    |                              — |                  6.37 |             ~5 |     ≤6    |
| Synth-JSON |                          28.09 |             (untested)| ~14 (UUID)     |     ≤17   |

The 2K-sample numbers leave HDFS/BGL/OpenStack short of the *original*
≤7/≤16 M4 targets — those corpora are bottlenecked by
information-theoretically-dense columns (random 60-bit block IDs,
microsecond timestamps, UUIDs) that lossless codecs cannot push below
the entropy floor. M4 targets revised accordingly:

- HDFS / BGL revised from ≤7 → ≤17.
- OpenStack stays at ≤16 (UUIDs to BF16+raw path = guaranteed 16 B/log).
- Apache / OpenSSH already meet target with first-cut ColumnarDrainPolicy.
- These are the **lossless** ceilings. Lossy compaction is explicitly
  out of scope (decision: 2026-04-26). The answer for "I have 100 K
  identical INFO logs/sec and want to retain the signal without the
  bytes" is logs-to-metrics derivation at a separate product layer.

Hitting 20× over raw OTLP/JSON on every corpus is the merge gate.
All five public corpora clear 20× with Drain+ZSTD-19 alone; the
typed-column stack must not regress that.

### M5: OTLP Logs Ingest Pipeline

Parse OTLP/proto or OTLP/JSON → group by stream → Drain → column
buffers → freeze.

**Deliverables:**
- `ingest(otlpBatch: ArrayBuffer): IngestStats` — protobuf and JSON.
- Stream grouping by `(resource_hash, scope_hash)`.
- Per-stream Drain state with cross-chunk persistence.
- Variable type classifier (int / float / string).
- Chunk close on row count or time cap.
- Counter: dropped logs, rejected logs, ingest pressure metrics.

**Benchmark gate:**

| Metric | TS target | Rust target |
|---|---|---|
| Ingest throughput | ≥20 K logs/s | ≥100 K logs/s |
| Parse 1 MB OTLP/proto | <30 ms | <8 ms |
| GC pauses (60 s sustained) | <100 ms | 0 ms |
| Peak memory delta | <10 MB | <5 MB |
| Bytes/log on k8s sample | ≤13.5 | ≤13.5 |

### M6: Indexes (zone map, binary fuse, Roaring-lite)

In-chunk skip indexes. The query engine needs these to avoid
decompressing chunks that cannot match.

**Deliverables:**
- Zone map per chunk: `{min_ts, max_ts, severity_min, severity_max,
  count, distinct_template_ids[]}`. Computed at chunk-close.
- BF8 over template IDs and over attribute key tokens.
- BF16 over trace IDs.
- Roaring-lite postings per chunk for low-cardinality columns
  (severity_number, common attribute values).
- Per-stream label index (sorted posting lists for label-set lookup).

**Benchmark gate:**

| Metric | Target |
|---|---|
| Zone-map build | <50 µs/chunk |
| BF8 build (avg chunk) | <2 ms |
| BF16 build (trace_ids in chunk) | <500 µs |
| Roaring AND (severity ∈ {WARN,ERROR,FATAL}) | <100 µs/chunk |
| Stream-label-index 2-key intersect | <1 µs at 100 K streams |
| Total index overhead | <2 B/log |

### M7: Streaming Query Executor + Builder API

Typed builder compiles to `LogQueryPlan` IR. Streaming chunk-at-a-time
executor with fixed scratch.

**Deliverables:**
- `QueryBuilder` API:
  ```ts
  store.query({
    range: {from, to},
    stream: { "service.name": "checkout" },
    filter: {
      severity: { gte: "WARN" },
      "attribute.http.status_code": { gte: 500 },
      body: { contains: "timeout" },
    },
    trace_id: "0xabc...",
    limit: 200,
  }).stream();
  ```
- `LogQueryPlan` IR: select, filter, join (for the trace_id path),
  aggregate (counts by severity / minute / template), tail.
- Streaming executor: chunk pruning by zone map → BF8/BF16 test →
  Roaring postings on low-card → decode only required columns →
  row-level predicates → emit.
- Aggregations: count by severity per minute, top templates,
  histogram strip per minute.
- Result types: `LogRecord[]` or columnar `LogColumns`.

**Benchmark gate:**

| Metric | Target |
|---|---|
| 1 M logs, severity≥WARN p50 | <5 ms |
| 1 M logs, body contains literal p50 | <20 ms |
| 1 M logs, trace_id lookup p50 | <2 ms |
| 1 M logs, top-100 templates p50 | <30 ms |
| Scratch memory | <2 MB fixed |

### M8: Worker Isolation + Public API

Web Worker wrapper. Public API surface. Adapters integration.

**Deliverables:**
- `O11yLogsDB` class: create/destroy, ingest, query, stats.
- Worker mode: engine in Worker, queries via `postMessage`.
- Transferable results: `Float64Array` / `Uint8Array` buffers
  zero-copy.
- Auto-detect WASM: try load `.wasm`, fall back to TS query path.
- `@otlpkit/logs-source` HTTP-receiver wrapper (separate package).
- Adapter hooks for `@octo11y/log-view`.

**Benchmark gate:**

| Metric | Target |
|---|---|
| Worker round-trip overhead | <2 ms |
| Frame drops at 60 fps + 50 K logs/s ingest | 0 |
| Bundle (TS only) | <50 KB gzip |
| Bundle (TS + WASM) | <120 KB gzip |

---

## Directory Structure

```
packages/o11ylogsdb/
├── PLAN.md                           ← this file
├── README.md
├── package.json
├── tsconfig.json
├── bench/
│   ├── harness.ts                    ← reuse o11ytsdb's
│   ├── corpora/
│   │   └── loghub-fixtures/          (gitignored, downloaded)
│   ├── bytes-per-log.bench.ts
│   ├── ingest.bench.ts
│   ├── query.bench.ts
│   ├── run.mjs
│   └── results/                      (gitignored)
├── src/
│   ├── index.ts                      ← public API re-exports
│   ├── chunk.ts                      ← M3: chunk format
│   ├── stream.ts                     ← M3: stream registry
│   ├── codec.ts                      ← M4: column codec dispatch (TS path)
│   ├── drain.ts                      ← M2: Drain (TS reference)
│   ├── fsst.ts                       ← M1: FSST (TS reference)
│   ├── ingest.ts                     ← M5: OTLP ingest
│   ├── index-bf.ts                   ← M6: binary fuse (TS)
│   ├── index-roaring.ts              ← M6: Roaring-lite (TS)
│   ├── query.ts                      ← M7: builder + executor
│   ├── plan.ts                       ← M7: LogQueryPlan IR
│   └── worker.ts                     ← M8: Worker isolation
├── rust/                             ← thin binding crate
│   ├── Cargo.toml                    ← deps on workspace crates
│   └── src/lib.rs                    ← extern "C" exports
├── wasm/
│   └── o11ylogsdb-rust.wasm          (gitignored, built artifact)
└── test/
    ├── chunk.test.ts                 ← cross-validates TS/Rust
    ├── codec.test.ts
    ├── drain.test.ts
    ├── fsst.test.ts
    ├── index-bf.test.ts
    ├── index-roaring.test.ts
    ├── ingest.test.ts
    ├── query.test.ts
    ├── stream.test.ts
    └── vectors/
        └── loghub/                   (test fixtures, small samples)
```

Adjacent (NEW shared workspace):

```
packages/o11y-codec-rt/
├── Cargo.toml                        ← workspace manifest
├── README.md
├── core/                             ← BitReader/Writer, dict builder
├── xor-delta/                        ← from o11ytsdb/rust/
├── alp/                              ← from o11ytsdb/rust/
├── fastlanes-bp/                     ← from o11ytsdb/rust/
├── fsst/                             ← NEW
├── drain/                            ← NEW
├── roaring-lite/                     ← NEW
└── binary-fuse/                      ← NEW
```

---

## Benchmark Protocol

Same as `o11ytsdb/PLAN.md`. The `bytes-per-log` benchmark is the
top-line gate; any change that regresses bytes/log >1% on any
benchmark corpus blocks merge.

**Corpora used in CI**: the public Loghub-2k samples (HDFS, Apache,
BGL, OpenStack, Linux, OpenSSH; small samples checked in; full
corpora downloaded via test setup), plus a synthetic structured-JSON
corpus shaped like a typical Node HTTP-logger record, plus a
representative k8s-app sample.

**The 20× promise must be verifiable in CI.** Each PR appends to
`bench/results/bytes-per-log-{date}.json`. The repo README publishes
the latest numbers — same model as `o11ytsdb`'s codec benchmark
table.

---

## What We Don't Build

- **Existing server-tier columnar archive formats as our storage
  format.** The candidates we evaluated bundle the same primitives
  we'll use (FSST, ALP, FastLanes BP), but the crates are tens of
  thousands of LoC and not designed for `wasm32-unknown-unknown`. The
  primitives are right; the packaging is server-tier. Build custom
  for the browser.
- **Whole-archive global-dictionary intermediate representations.**
  These rely on archive-scoped dictionaries that don't fit a
  streaming-decode browser store. We close chunks and serve queries
  in real time, so there's no archive boundary to share a dict across.
- **Trained ZSTD dictionaries per stream.** A 16 KB-trained ZSTD-19
  dict ties or *loses* on 5/5 text corpora and 3/4 string corpora at
  our chunk granularity. The literature "10–30% gain" doesn't hold
  for 1024-row chunks. Removed entirely.
- **Global cross-stream variable dictionary.** Adds 10–30% compression
  but breaks streaming-decode locality. Revisit if we add a server-
  side cold tier.
- **Global inverted index on body tokens.** Per-chunk binary fuse
  filtering covers 95% of substring search needs at a fraction of the
  cost.
- **String-DSL query parser.** The typed builder is sufficient for v1.
  ~800 LoC of parser deferred to v1.1.
- **Persistence.** In-memory only. `serialize()` / `deserialize()` on
  chunks for the caller to use IndexedDB if they want.
- **Multi-tenancy, auth, clustering.** Single user, single tab.
- **Native-tier columnar archive export** (server-tier interop). v2.
- **Adaptive chunk sizing.** Default 1024 rows + 5-min cap is fine.
- **WebGPU heatmap rendering.** Belongs in adapter packages, not here.

---

## Performance Targets Summary

Production targets on Node 22+ and modern browser V8 / SpiderMonkey.

| Metric | Target | Hard ceiling |
|---|---|---|
| **Storage: B/log on KVList-heavy mix (structured-JSON loggers)** | ≤17 | 22 |
| **Storage: B/log on templated-text-heavy mix** | ≤12 | 18 |
| **Storage: B/log on HDFS-shape corpus** | ≤7 | 10 |
| **Storage: B/log on Apache-shape corpus** | ≤4 | 6 |
| **Storage: B/log on OpenStack-shape corpus** | ≤16 | 22 |
| Compression ratio vs raw OTLP/JSON | ≥20× | — |
| Compression ratio vs OTLP/protobuf | ≥10× | — |
| Memory for 1 M logs | <50 MB | 100 MB |
| Ingest (TS) | ≥20 K logs/s | — |
| Ingest (Rust) | ≥100 K logs/s | — |
| FSST decode (Rust→WASM) | ≥1 GB/s | (currently 4.93 GB/s measured) |
| Query: severity≥WARN over 1 M | <5 ms | 20 ms |
| Query: body contains over 1 M | <20 ms | 100 ms |
| Query: trace_id lookup over 1 M | <2 ms | 10 ms |
| Bundle (TS only) | <50 KB gzip | 80 KB |
| Bundle (TS + WASM) | <120 KB gzip | 180 KB |
| `o11ylogsdb-rust.wasm` size | **<25 KB gzip** | 30 KB |

---

## Open Questions

1. **Per-chunk dict vs cross-chunk shared dict.** Per-chunk dict is
   simpler. A cross-chunk dict gains 0.13–1.01 B/log on top of
   per-chunk ZSTD-19 but adds a cross-chunk decode dependency. Keep
   on the M5 background-compaction shortlist; not a hot-path lever.
2. **Out-of-order ingestion.** Same question `o11ytsdb` faced; likely
   the same answer (small reorder buffer at the chunk boundary).
3. **Template-tree memory cap.** Per-stream Drain state grows on new
   builds; LRU on least-recently-used templates. Cap matters only on
   adversarial input.
4. **Eviction policy.** Global byte budget with per-stream weighting
   by access recency.
5. **Worker memory model.** SharedArrayBuffer requires COOP/COEP;
   gate it behind feature detection. Same call as `o11ytsdb`.
6. **Byte-pair-encoding string codec for free-text bodies.** Measures
   ~3× FSST's compression ratio at ~6× FSST's decode speed on
   free-text fragments. Free-text is <1% of real traffic, so impact
   is small; revisit if real workloads emerge with higher free-text
   share.

---

## Validation Status

Detailed findings — what we measured, what we ship, what we refuted —
live in [`dev-docs/findings.md`](./dev-docs/findings.md). Each finding
maps to a reproducible bench module under `bench/`. Highlights:

- 20× over raw OTLP/JSON achievable on every public log corpus with
  Drain + ZSTD-19 alone. Build custom (server-tier columnar archive
  formats are too large for `wasm32-unknown-unknown`).
- WASM throughput 5× over target (4.93 GB/s FSST decode); per-engine
  size budget revised to <25 KB gz.
- Trained ZSTD dictionaries don't pay at chunk granularity (0/5
  text-corpus wins, 1/4 string-corpus wins).
- Body shape distribution revised: ~61% templated / ~39% KVList /
  <1% free-text. KVList recursive flatten is a first-class M4 path.
- Per-stream chunking is a 1.13–1.28× compression bonus (not the
  1.5–2× originally projected). Primary value is the query model.
- TS port = Rust port = published Python reference for Drain
  (ARI = 1.0). Dual-implementation protocol mutual-oracle requirement
  satisfied for M2.
- Layout > Drain. Binary columnar payload with codec metadata moved
  inside the compressed payload beats NDJSON+ZSTD on 6/6 corpora
  before Drain is applied.
- Per-template typed-slot codec dispatch (PREFIXED_INT64, UUID,
  TIMESTAMP_DELTA, etc.) recovers 17–35% on identifier-heavy
  corpora — the highest-leverage M4 lever.
- Per-stream Drain isolation costs 0.11% over shared Drain. Engine
  ships shared-by-default; per-stream available via `policyFactory`.
- Hierarchical Drain on KVList sub-fields is refuted (saves 0.64
  B/log aggregate; +5 B/log when accidentally applied to UUID
  columns). Apply Drain only to top-level string-typed bodies.
- Per-chunk body trigram filters and per-token Roaring postings are
  refuted at chunk scope. Substring queries fall back to template-ID
  prune + decompress-and-scan; per-token postings revisited at
  stream scope in M7.
- Body @ z3 + structural @ z19 is the hot-ingest config. Background
  compaction promotes body to z19. Structural columns are free at
  any ZSTD level.

---

## Stretch Goals (post-v1)

- **Logs↔Traces↔Metrics correlation in a single tab.** Once
  `o11ytracesdb` ships alongside `o11ytsdb` and `o11ylogsdb`, joining
  a metric spike → contributing trace IDs → logs from those traces is
  the product-level promise of the o11ykit family. Plan for it in the
  public API surface from day one.
- **Logs-to-metrics derivation layer.** A separate product layer
  built on top of o11ylogsdb that takes a stream of templated logs
  and emits counters + duration histograms per (template, attribute
  bucket) per minute. The user opts in per-stream; the resulting
  metrics flow to `o11ytsdb`. This is the principled answer to
  "I have 100 K identical INFO logs/sec and want to retain the
  signal without the bytes" — it preserves byte-level information in
  the log store (or drops the logs entirely if retention is
  configured) while keeping queryable signal in the metric store.
  Not a storage-engine concern.
- **Byte-pair-encoding string codec** for the free-text body path —
  ~3× FSST's compression ratio at ~6× FSST's decode speed on
  free-text fragments. Add only if real workloads emerge with
  non-trivial free-text share.
- **WebGPU histogram strip** rendered directly from Roaring postings.
- **Native-tier columnar archive interop** for server-side cold-tier
  export/import.

## Out of scope

- **Lossy compression / cold-tier rewriting.** Decision 2026-04-26:
  the engine preserves bytes. Numeric-ID masking + IP normalization
  recovers HDFS to 6.65 B/log on the lossy side, but the storage
  engine itself never rewrites bytes destructively. Use logs-to-
  metrics derivation above for the same product goal.

## Patterns adopted from production logs systems

A vendor-neutral catalog of architectural patterns we adopt — and the
reasoning — lives in [`dev-docs/techniques.md`](./dev-docs/techniques.md).
Five actionable patterns fit our constraints (browser-native,
lossless, <25 KB gz WASM):

1. **Stable chunk-list ordering by `(stream_fingerprint,
   ts_bucket_start)`** plus a chunk-level zone map on the resource
   fingerprint. A query that filters on resource attributes prunes
   most of the chunk list without decode. Lands in M3 + M7.
2. **Bloom over structured-metadata `key=value`, not body trigrams.**
   Confirms the M6 plan: BF8 over template IDs + BF16 over trace IDs
   is the right shape; body trigrams refuted by our own measurements.
3. **Native typed sub-columns beat string-map shapes.** Vindicates
   M4 lazy column materialization. Also implies dropping any
   BF8-over-attribute-key index in favor of column-existence
   metadata (an existing column at chunk-build time is presence).
4. **Result cache at `(query_hash, chunk_id)` granularity.** Chunks
   are immutable; cache invalidation is trivial. M7 deliverable.
5. **Per-token Roaring postings at stream scope** (not per-chunk).
   The 1–2 B/log economics from production systems apply at
   stream-scope aggregation across many chunks; per-chunk at
   1–2K rows the index is larger than the source. M7 candidate.
