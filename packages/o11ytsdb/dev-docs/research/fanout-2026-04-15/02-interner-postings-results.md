# M2 + M3 Results — Interner + MemPostings (2026-04-15)

## Scope

This workstream implemented:

- `src/interner.ts` (FNV-1a + open-addressed typed-array string interner)
- `src/postings.ts` (`MemPostings` inverted index with galloping intersection)
- Storage backend integration (`flat-store`, `chunked-store`, `column-store`)
- New benches (`bench/interner.bench.ts`, `bench/postings.bench.ts`)
- Rust/WASM interner exports (`rust/src/lib.rs`)

## Benchmark setup

Commands run:

- `node bench/run.mjs interner`
- `node bench/run.mjs postings`

Data shape:

- 10K unique interner strings for throughput tests.
- 10K series for postings + query-match tests.
- Intersection tests at set sizes 100, 1K, 10K.

## Intern throughput (TS vs WASM)

### TypeScript interner (measured)

- `intern_10k`: **953.18K ops/s p50** (684.46K p99)
- `resolve_10k`: **6.01M ops/s p50** (4.34M p99)

### Rust/WASM interner (status)

- Rust interner ABI functions were implemented:
  - `internerReset`
  - `internerIntern(ptr,len) -> id`
  - `internerResolve(id,out_ptr,out_cap) -> len`
- This environment did not have the `wasm32-unknown-unknown` target installed, so Rust WASM could not be built and executed for measured throughput.

## Memory savings vs raw `Map<string,string>` style label storage (10K series)

Derived memory check (10K series with 4 labels each):

- Raw duplicated UTF-16 bytes: **1,119,000 bytes**
- Interner structural memory: **22,528 bytes**
- Savings ratio: **49.67×**

This exceeds the roadmap gate (≥8×) by a wide margin.

## Galloping intersection throughput (100 / 1K / 10K)

From `postings` benchmark:

- Size 100:
  - Galloping: **747.38K ops/s**
  - Naive (`Set`+filter): **95.36K ops/s**
  - Speedup: **~7.8×**
- Size 1K:
  - Galloping: **75.01K ops/s**
  - Naive: **5.95K ops/s**
  - Speedup: **~12.6×**
- Size 10K:
  - Galloping: **7.33K ops/s**
  - Naive: **80.69 ops/s**
  - Speedup: **~90.8×**

## Label match + query speedup vs current linear scan

From `postings` benchmark at 10K series:

- Postings-based label match + intersection: **10.52K ops/s**
- Linear scan over label maps: **4.15K ops/s**
- End-to-end selector speedup: **~2.5×**

## Recommendation

Ship the **TypeScript interner + TS MemPostings** immediately:

- It already hits required performance characteristics in this environment.
- It achieves >8× memory savings (observed ~49.7× on duplicated label bytes).
- Galloping intersection is materially faster than naive approaches, with widening gains at higher cardinalities.

Then ship Rust/WASM interner as an optional fast path once CI/dev images include `wasm32-unknown-unknown`, and keep TS as the default fallback + correctness oracle.

## Optional exploration notes

- **Bloom filter pre-screening**: likely useful for very high-cardinality labels with expensive regex/value scans.
- **Adaptive resize strategy**: can tune interner table growth factors based on probe depth percentiles.
- **Composite label-set interning**: interning sorted `(k,v)` tuples as one key could reduce per-series series-key construction overhead.
