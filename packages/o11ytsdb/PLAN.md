# o11ytsdb — Execution Plan

## What This Is

A browser-native time-series database for OpenTelemetry data. Ingests
OTLP JSON, stores compressed, serves streaming queries. No backend.

**Performance is the product.** Every design decision is benchmarked.
Every PR ships numbers.

## Priority Stack (non-negotiable ordering)

1. **Smallest memory footprint** — Fits in 50 MB for 10K series.
2. **Fastest query** — 10K series × 1024 points in <100 ms.
3. **Fastest ingest** — Sustain 200K samples/sec (WASM), 50K (TS).

When these conflict, memory wins. A feature that saves 10 ms of query
time but costs 20% more memory gets rejected.

---

## The Triple Implementation Protocol

Every hot-path module has three implementations: TypeScript, Zig→WASM,
and Rust→WASM. They serve as mutual oracles.

### Rules

1. **All three must exist before merge.** No "we'll add WASM later."
2. **Cross-validate all test vectors.** TS encode → Zig decode →
   Rust decode, and every other permutation. If any two disagree,
   there's a bug. Find it.
3. **Benchmark all three on every PR.** Results go in `bench/results/`.
   CI compares against the baseline commit. Regressions block merge.
4. **Ship the winner.** After benchmarking, pick the best WASM backend
   (Zig or Rust) for .wasm binary size, throughput, and decode speed.
   Ship TS as the always-available fallback. Auto-detect WASM support
   at runtime.
5. **No vendor names in source.** Algorithms have papers, not brands.
   Call it "xor-delta compression," not "Gorilla." Call it "float-int
   conversion," not "VictoriaMetrics decimal." The code should read
   like a textbook, not a changelog of other people's projects.

### Why Three

- Correctness: three independent implementations catch spec bugs that
  two might share by coincidence.
- WASM shootout: Zig promises smallest binaries and explicit memory.
  Rust promises mature toolchain and ecosystem. Benchmark, don't guess.
- Portability: TS-only build works everywhere, WASM build is faster.
- Culture: if you can't write it in both Zig and Rust, you don't
  understand the algorithm well enough to ship it.

### WASM Comparison Criteria

Every module benchmark reports these per-runtime:

| Criterion | How we measure |
|-----------|----------------|
| Binary size | `wasm-opt -Oz` output, gzipped |
| Encode throughput | samples/sec at p50 |
| Decode throughput | samples/sec at p50 |
| Peak memory | WASM linear memory high-water mark |
| Build time | cold build, seconds |
| Toolchain friction | subjective, logged in bench notes |

---

## Module Map

Dependency order. Each module has a benchmark gate that must pass
before the next module starts. The gate numbers come from our
[research benchmarks](../../research/bench-results.txt).

```
M0  Benchmark Harness       ← build first, everything depends on this
 │
M1  Bit I/O + XOR-Delta Codec
 │
M2  String Interner ──────── M3  Inverted Index (MemPostings)
 │                            │
M4  Chunk Store ─────────────┘
 │
M5  OTLP Ingest Pipeline
 │
M6  Streaming Query Executor
 │
M7  Histogram Storage + Query
 │
M8  Worker Isolation + Public API
```

### M0: Benchmark Harness

Build the measurement infrastructure before writing a single line of
domain code. You can't optimize what you can't measure.

**Deliverables:**
- Statistical benchmark runner: warmup, N iterations, min/p50/p95/p99/max
- Memory measurement: heap snapshots via `performance.measureUserAgentSpecificMemory()`
  in browser, `process.memoryUsage()` in Node
- GC pause measurement: `PerformanceObserver` for GC events
- Dual-impl test vector protocol: generate vectors in TS, validate in
  all three runtimes, report any disagreement as test failure
- Machine-readable JSON output: `bench/results/{module}-{date}.json`
- CLI: `node bench/run.mjs [module]` runs benchmarks, prints table
- CI comparison: diff current results against baseline, flag regressions

**No gate** — this is the gate infrastructure itself.

### M1: Bit I/O + XOR-Delta Codec

The compression engine. XOR-delta encoding for float64 values,
delta-of-delta encoding for int64 timestamps. This is the algorithm
from the Facebook 2015 paper, stripped of branding.

**TS deliverables:**
- `BitWriter`: append bits to a growable `Uint8Array`
- `BitReader`: read bits from a `Uint8Array`
- `encodeChunk(timestamps: BigInt64Array, values: Float64Array): Uint8Array`
- `decodeChunk(buf: Uint8Array): { timestamps: BigInt64Array, values: Float64Array }`
- 64-bit precision: use `DataView` for float↔bits, `BigInt` pairs for
  XOR/CLZ/shift. The research prototype had a precision bug here. Fix it.

**Zig deliverables:**
- Same API, exported as WASM functions
- Operates on WASM linear memory (caller allocates input/output buffers)
- No allocations in the hot path

**Rust deliverables:**
- Same API, same ABI as Zig (#[no_mangle] extern "C")
- `#![no_std]` — no allocator, no panics in hot paths
- `opt-level = "z"` + LTO for smallest binary

**Benchmark gate:**

| Metric | TS target | Zig target | Rust target | Research baseline |
|--------|-----------|------------|-------------|-------------------|
| Encode throughput | ≥500K samples/s | ≥2M samples/s | ≥2M samples/s | 896K (TS proto) |
| Decode throughput | ≥5M samples/s | ≥15M samples/s | ≥15M samples/s | 5.2M (TS proto) |
| Compression (gauges) | ≥2.0x | ≥2.0x | ≥2.0x | 2.5x |
| Compression (counters) | ≥2.0x | ≥2.0x | ≥2.0x | 2.3x |
| Round-trip correctness | bit-exact | bit-exact | bit-exact | FAILED (proto bug) |
| .wasm binary size | N/A | <20 KB | <20 KB | — |

### M2: String Interner

Map repeated strings (label names, label values, metric names) to
compact integer IDs. Every downstream structure uses IDs, never strings.

**Deliverables:**
- `Interner`: string → u32 ID, ID → string lookup
- FNV-1a hash, open-addressing hash table
- Typed-array backing (no JS Map/Object overhead on hot path)
- Bulk intern: accept OTLP attribute arrays, return `Uint32Array` of IDs

**Benchmark gate:**

| Metric | Target | Research baseline |
|--------|--------|-------------------|
| Intern throughput | ≥1M strings/s | - |
| Lookup (ID→string) | <50 ns | - |
| Memory per entry | <100 bytes | - |
| Memory savings vs raw | ≥8x | 9.1x |

### M3: Inverted Index (MemPostings)

Map label=value pairs to sorted arrays of series IDs. This is how
queries find matching series without scanning everything.

**Deliverables:**
- `MemPostings`: add(seriesID, labels), lookup(label, value) → `Uint32Array`
- Multi-label intersection with galloping search (exponential + binary)
- All postings stored as sorted `Uint32Array` (cache-friendly, no Set overhead)
- Add: O(1) amortized. Intersect: O(min(n,m) · log(max(n,m)/min(n,m)))

**Benchmark gate:**

| Metric | Target | Research baseline |
|--------|--------|-------------------|
| 1-label lookup | <100 ns at 100K series | ~0 µs |
| 2-label intersect | <1 µs at 100K series | 0.5 µs |
| 3-label intersect | <2 µs at 100K series | 0.6 µs |
| Memory per posting | 4 bytes (u32) | 4 bytes |

### M4: Chunk Store

Per-series compressed chunk storage. Each series has one hot chunk
(accepting appends) and zero or more frozen chunks.

**Deliverables:**
- `Chunk`: 120-point XOR-delta compressed block with min_t/max_t index
- `Series`: hot chunk + frozen chunk list + metadata (metric type, unit)
- `ChunkStore`: series ID → Series lookup
- Append: encode sample into hot chunk, freeze when full
- Time-range pruning: skip chunks outside query window
- Memory tracking: exact byte count per series, per chunk

**Benchmark gate:**

| Metric | Target | Research baseline |
|--------|--------|-------------------|
| Append latency | <200 ns/sample | - |
| Freeze latency | <50 µs/chunk | - |
| Overhead per series | <200 bytes (excl. data) | - |
| Chunk overhead | <16 bytes (excl. compressed data) | - |
| Time-range prune | O(log N) chunks | - |

### M5: OTLP Ingest Pipeline

Parse OTLP JSON → route samples to correct series → append to chunks.
Handle all five OTLP metric types.

**TS deliverables:**
- `ingest(json: string | ArrayBuffer): IngestStats`
- JSON.parse + tree walk, intern strings, resolve series, append
- Delta-to-cumulative conversion for sum metrics
- Counter reset detection (value decreases → reset event)

**Zig deliverables:**
- Schema-aware JSON scanner: skip unknown fields, emit directly to
  column buffers in WASM linear memory
- Zero JS object allocation in the hot path
- The crossover point where WASM beats JSON.parse is ~100 KB payloads
  (research hypothesis — benchmark will validate)

**Benchmark gate:**

| Metric | TS target | Zig target | Notes |
|--------|-----------|------------|-------|
| Ingest throughput | ≥50K pts/s | ≥200K pts/s | Sustained 60s |
| Parse 10 KB payload | <1 ms | <0.5 ms | Small batch |
| Parse 1 MB payload | <50 ms | <15 ms | Large batch |
| GC pauses (60s run) | <100 ms total | 0 ms | Key WASM advantage |
| Peak memory delta | <5 MB | <2 MB | Above baseline |

### M6: Streaming Query Executor

Chunk-at-a-time query execution with fixed scratch memory. Never
allocate arrays proportional to total data size.

**Deliverables:**
- `QueryPlan` IR: select, filter, aggregate, transform, align nodes
- Builder API: `query().metric("http.requests").rate().sumBy("endpoint")`
- Streaming executor: decode one chunk → fold into accumulator → next
- Fixed scratch: `Float64Array(120)` for decode, accumulator per output series
- Transforms: `rate`, `increase`, `sum`, `avg`, `min`, `max`, `count`,
  `topk`, `bottomk`
- Time alignment: step-aligned bucketing with configurable resolution

**Benchmark gate:**

| Metric | Target | Research baseline |
|--------|--------|-------------------|
| 1K series × 1024 pts | <20 ms | 135 ms (materialized) |
| 10K series × 1024 pts | <100 ms | ~1350 ms (extrapolated) |
| Scratch memory | <1 MB fixed | 16 KB |
| Memory (vs materialize) | ≥100x less | 1000x less |

### M7: Histogram Storage + Query

Histograms are 10-50x more expensive per point than scalars. They
need specialized storage and query paths.

**Deliverables:**
- Columnar per-bucket storage (each bucket column = one XOR-delta stream)
- `histogram_quantile(φ, metric)`: streaming linear interpolation
- Exponential histogram: variable scale handling, merge across scales
- Heatmap output format: time × bucket → count matrix

**Benchmark gate:**

| Metric | Target | Notes |
|--------|--------|-------|
| Storage per histogram point | <20 bytes × buckets | vs 16 bytes scalar |
| histogram_quantile (1K series) | <10 ms | Streaming, not materialized |
| Heatmap matrix (1K × 20 buckets) | <5 ms | Direct from chunks |

### M8: Worker Isolation + Public API

Web Worker wrapper for UI-thread isolation. Public API surface.
Integration with existing `@otlpkit/adapters`.

**Deliverables:**
- `O11yTSDB` class: create/destroy, ingest, query, stats
- Worker mode: engine runs in Worker, queries via `postMessage`
- Transferable results: `Float64Array` buffers transferred zero-copy
- Auto-detect WASM: try load .wasm, fall back to TS kernels
- Adapter hooks: output `TimeSeries[]` compatible with `@otlpkit/views`

**Benchmark gate:**

| Metric | Target | Notes |
|--------|--------|-------|
| Worker round-trip overhead | <2 ms | postMessage + transfer |
| Frame drops (60 fps + queries) | 0 | The whole point |
| Bundle size (TS only) | <30 KB gzip | |
| Bundle size (TS + WASM) | <80 KB gzip | |

---

## Directory Structure

```
packages/o11ytsdb/
├── PLAN.md
├── package.json
├── tsconfig.json
├── bench/
│   ├── harness.ts          # Statistical benchmark runner
│   ├── vectors.ts          # Shared test data generators
│   ├── run.mjs             # CLI: node bench/run.mjs [module]
│   └── results/            # Machine-readable JSON (gitignored)
├── src/
│   ├── index.ts            # Public API re-exports
│   ├── interner.ts         # M2: String interner
│   ├── postings.ts         # M3: Inverted index
│   ├── codec.ts            # M1: XOR-delta codec (TS)
│   ├── chunk.ts            # M4: Chunk + ChunkStore
│   ├── ingest.ts           # M5: OTLP ingest pipeline
│   ├── query.ts            # M6: Streaming query executor
│   ├── histogram.ts        # M7: Histogram storage + query
│   └── worker.ts           # M8: Worker isolation
├── zig/
│   ├── build.zig           # Zig build → WASM
│   └── src/
│       ├── root.zig        # WASM exports
│       ├── codec.zig       # M1: XOR-delta codec (Zig)
│       ├── interner.zig    # M2: String interner (Zig)
│       └── ingest.zig      # M5: JSON scanner (Zig)
├── rust/
│   ├── Cargo.toml          # Rust build → WASM
│   └── src/
│       ├── lib.rs          # WASM exports (mirrors root.zig)
│       ├── codec.rs        # M1: XOR-delta codec (Rust)
│       ├── interner.rs     # M2: String interner (Rust)
│       └── ingest.rs       # M5: JSON scanner (Rust)
├── wasm/                   # Built .wasm artifacts (gitignored)
│   ├── o11ytsdb-zig.wasm
│   └── o11ytsdb-rust.wasm
└── test/
    ├── codec.test.ts       # Cross-validates TS, Zig, and Rust
    ├── interner.test.ts
    ├── postings.test.ts
    ├── chunk.test.ts
    ├── ingest.test.ts
    ├── query.test.ts
    └── vectors/            # Shared test fixtures
        └── ...
```

---

## Benchmark Protocol

Every PR follows this protocol. No exceptions.

### Before writing code

1. Write the benchmark for the module you're about to change.
2. Run it against `main`. Record the baseline.
3. If there's no benchmark yet, that's the first PR.

### During development

4. Run benchmarks after every significant change.
5. If a change regresses memory: revert. Memory is #1 priority.
6. If a change regresses query speed but helps memory: keep it.
7. If a change regresses ingest but helps query: keep it.

### Before merge

8. Run full benchmark suite. Produce comparison table.
9. Include benchmark table in PR body. No table → no review.
10. CI validates: no regression >5% on any gate metric.

### Benchmark output format

```json
{
  "module": "codec",
  "timestamp": "2026-04-12T00:00:00Z",
  "commit": "abc123",
  "runtime": "ts",
  "results": [
    {
      "name": "encode_gauge_1024",
      "unit": "samples/sec",
      "min": 480000,
      "p50": 520000,
      "p95": 540000,
      "p99": 545000,
      "max": 550000,
      "iterations": 1000
    }
  ],
  "memory": {
    "heapUsed": 1048576,
    "heapTotal": 2097152
  }
}
```

---

## What We Don't Build

- Query language parser (builder API is sufficient)
- Chart rendering (adapters to existing libraries)
- Networking (caller provides OTLP JSON)
- Persistence (in-memory only; expose serialize/deserialize)
- Multi-tenancy, auth, clustering
- Dashboard framework
- Adaptive chunk sizing (research shows <3% benefit)
- SharedArrayBuffer multi-tab (COOP/COEP deployment friction)
- WebGPU anything (adoption too low)

---

## Performance Targets Summary

From research benchmarks on Node 18 single-core. Production targets
are tighter because we'll be on Node 22+ and browser V8.

| Metric | Target | Hard ceiling |
|--------|--------|--------------|
| Memory per series (10K cardinality) | <200 B overhead | 500 B |
| Memory for 10K × 1024 pts | <50 MB | 80 MB |
| Compression ratio (avg) | ≥2.5x | — |
| Encode (TS) | ≥500K samples/s | — |
| Encode (Zig) | ≥2M samples/s | — |
| Decode (TS) | ≥5M samples/s | — |
| Decode (Zig) | ≥15M samples/s | — |
| Ingest pipeline (TS) | ≥50K pts/s | — |
| Ingest pipeline (Zig) | ≥200K pts/s | — |
| Query 10K × 1024 | <100 ms | 200 ms |
| Query scratch memory | <1 MB | 2 MB |
| Index 2-label intersect (100K) | <1 µs | 5 µs |
| Bundle (TS only) | <30 KB gzip | 50 KB |
| Bundle (TS + WASM) | <80 KB gzip | 120 KB |
