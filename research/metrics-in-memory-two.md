# In-browser OTLP metrics engine with dual-mode storage and PromQL

**No browser-based PromQL evaluator or client-side TSDB exists today â€” this would be a first-of-its-kind system.** The architecture is feasible but requires confronting a hard constraint: WASM cannot access external JS ArrayBuffers directly, so the "JS-owns-memory, WASM-computes" split demands a fixed-size scratch-buffer pattern rather than zero-copy shared access. The most dangerous design risk is counter reset detection under lossy precision â€” a single rounded-down sample can inject a false reset that adds the entire counter magnitude to `rate()` output, producing thousand-percent error spikes. Every major building block exists (Rust PromQL parser at 376K crate downloads, Gorilla encoding at 1.37 bytes/sample, Thanos-style AggrChunks with 5 mergeable aggregates, protobuf+snappy in browser), but the evaluator must be built from scratch.

This report covers the seven research areas in descending order of architectural impact, with specific algorithms, data structures, source references, and measured performance numbers throughout.

---

## The WASM memory wall forces a scratch-buffer architecture

The user's core architectural insight is correct â€” WASM linear memory can only grow, never shrink â€” but the proposed mechanism needs adjustment. **WASM modules cannot read or write external JS ArrayBuffers.** The WebAssembly specification restricts each module to operating exclusively on its own linear memory. There is no `new WebAssembly.Memory(existingArrayBuffer)` constructor; GitHub issue `WebAssembly/design#1162` has 49+ upvotes requesting this but remains unresolved as of 2026.

The viable architecture is a **fixed-size scratch buffer** pattern: JS owns all time series data in TypedArrays and ArrayBuffers (which are garbage-collectible). When computation is needed, JS copies the relevant chunk into a pre-allocated region of WASM linear memory, WASM computes, and JS reads results back via TypedArray views over `wasmInstance.exports.memory.buffer`. The scratch buffer never grows because its size is fixed at instantiation â€” say, **64 MB** for a working set â€” while the JS-side data store scales independently.

**Maximum WASM linear memory** is 4 GB in Chrome, Firefox, and Safari for wasm32. Memory64 (Phase 4, shipped in Chrome/Firefox) extends this to 16 GB but incurs a 10â€“100% performance penalty because 64-bit mode prevents the "reserve 4GB virtual address space" optimization that eliminates bounds checks. For a metrics engine, wasm32 with a fixed 64â€“256 MB scratch allocation is optimal.

**JSâ†”WASM boundary cost** is ~5â€“10 ns per call for numeric arguments and ~1â€“2 GB/s for bulk memcpy. For a 1 MB chunk (roughly 60K samples at 16 bytes each), copy time is **~0.5â€“1 ms** â€” negligible against typical query latency budgets. The critical optimization is batching: one call with 10K samples vastly outperforms 10K calls with one sample. Benchmarks show WASM achieves **5â€“10Ã— speedup** over JS for CPU-bound numeric work (factorial: 2 ms WASM vs 10 ms JS; image processing: 80 ms vs 200 ms), but this advantage disappears when boundary crossing dominates.

**SharedArrayBuffer** enables a more sophisticated pattern: create `new WebAssembly.Memory({ initial: 1024, maximum: 4096, shared: true })`, then share this Memory object across Web Workers via `postMessage`. Multiple WASM instances can operate on the same shared memory with atomic instructions for synchronization. This requires cross-origin isolation headers (COOP + COEP). DuckDB-WASM, Perspective (FINOS), and SQLite-WASM all use WASM linear memory internally rather than JS-side buffers, and SQLite-WASM has documented severe heap fragmentation in long-running sessions â€” after 280K operations, the heap became "Swiss cheese" and crashed with "memory access out of bounds." This validates the JS-side storage approach.

**Ring buffers** in JS are the natural data structure for fixed-retention windows. A `Float64Array(capacity)` with a head pointer and modulo arithmetic gives O(1) push, constant memory, and automatic eviction. For compressed chunk storage, use a **bip buffer** (bipartite buffer) pattern that always returns contiguous memory regions, avoiding the problem of a compressed block straddling the wrap-around boundary.

**Memory pressure detection** is Chrome-only via `performance.measureUserAgentSpecificMemory()` (requires cross-origin isolation) and `navigator.deviceMemory` (returns approximate device RAM as 2/4/8/16/32 GB). No cross-browser memory pressure event API exists. The engine should read `navigator.deviceMemory` at startup to set an initial memory budget, then track ArrayBuffer allocations manually. When approaching 70% of budget, increase compression or reduce retention.

---

## Lossy storage that preserves PromQL semantics requires per-function analysis

The feasibility of lossy storage depends entirely on which PromQL functions must produce correct results. The research reveals a sharp divide: aggregation functions tolerate precision loss gracefully, while counter-based functions can fail catastrophically.

**Precision reduction (Float64â†’Float32)** halves memory per raw value from 8 to 4 bytes while preserving ~7 significant decimal digits. This is adequate for gauges (CPU utilization, memory usage, temperature) but dangerous for counters. A counter at value 16,777,217 stored as Float32 becomes 16,777,216 (Float32 cannot represent integers above 2Â²â´ exactly), creating a false decrease that triggers counter reset detection. **Float16** is viable only for bounded percentage metrics (0â€“100% at 0.1% resolution) since its maximum representable value is 65,504 and precision near 1.0 is only 1/1024 â‰ˆ 0.001.

**Swinging Door Trending (SDT)** compression achieves **80â€“98% point reduction** in industrial process data (OSIsoft PI, Honeywell PHD). The algorithm maintains a "compression corridor" â€” two lines (slopes) from an anchor point at Â±tolerance. Each new sample narrows the valid slope range. When a sample falls outside the corridor, the previous point is stored and becomes the new anchor. SDT is O(n) time, O(1) space, perfect for streaming ingestion. Open-source implementations exist in Apache StreamPipes (Java) and various GitHub repositories. For a browser engine, SDT is trivially implementable in TypeScript with per-metric configurable tolerance: tight (0.5 ms) for latency, loose (1%) for CPU utilization.

**Gorilla/XOR encoding** (Facebook, VLDB 2015) remains the baseline for lossless time series compression at **1.37 bytes/sample** (12Ã— reduction from 16 bytes). Timestamps use delta-of-delta encoding where 96% compress to 1 bit (regular intervals). Values use XOR with the previous value â€” 51% are identical (1 bit), 30% fit in the previous zero-region (~27 bits), 19% need full encoding (~37 bits). Prometheus uses this internally as `EncXOR` chunks targeting ~120 samples (~2 hours at 15s scrape). The encoding supports **streaming decompression** â€” one sample at a time with ~20 bytes of iterator state â€” making it ideal for the Prometheus-style `Seek(t)`/`Next()`/`At()` interface.

**Modern alternatives** offer better compression ratios. ALP (CWI, SIGMOD 2024 Best Artifact Award) achieves **49% better compression than Gorilla** by detecting decimal-origin floats and converting to integers, with decode speed **55Ã— faster** via SIMD vectorization. Pcodec (Feb 2025) achieves **29â€“94% better compression** than alternatives with >1 GiB/s decode throughput. Chimp (VLDB 2022) improves on Gorilla by XOR-ing against the best of 128 previous values rather than just the previous one. **ALP and Pcodec require block decompression** (1024â€“8192 values at a time) rather than streaming, meaning the query engine must decompress an entire block to access any sample â€” a tradeoff of throughput for latency. For a browser engine, the recommended hybrid: Gorilla for interactive queries (streaming decode, small ranges), ALP via WASM for analytical queries (block decode, large aggregations).

**VictoriaMetrics** achieves **0.4 bytes/sample** (3.4Ã— better than Gorilla) through a lossy technique: convert Float64 to decimal representation by multiplying by 10^k to get integers, then delta-encode and Zstd-compress. Precision loss occurs for values with >12 significant digits â€” acceptable for most monitoring data.

### Recommended precision configuration per metric type

| Metric Type | Default Mode | Precision | Rationale |
|---|---|---|---|
| Counter | **Lossless** (Float64) | Full | rate()/increase() amplify precision errors by counter magnitude |
| Gauge | Lossy (Float32) | ~7 significant digits | Absolute values; precision loss is bounded and proportional |
| Histogram buckets | Lossless (Float64 boundaries, Float32 counts) | Boundaries exact, counts approximate | histogram_quantile() interpolates between boundaries |
| Summary quantiles | Lossless (Float64) | Full | Quantile accuracy depends on precision |
| Timestamps | Always int64 milliseconds | Exact | Delta-of-delta encoding requires exact timestamps |

---

## Counter reset detection is the critical failure mode for lossy PromQL

The Prometheus `rate()` function uses a simple comparison for counter reset detection: `if current < previous, assume reset`. This single line of code (in `prometheus/promql/functions.go`, the `extrapolatedRate` function) creates two catastrophic failure modes under lossy storage.

**False zero-rate**: A counter increments from 1000.0 to 1000.1, but Float32 rounding stores both as 1000. `rate()` computes `(1000 - 1000) / Î”t = 0`, reporting no activity when activity occurred. For slowly-incrementing counters (low-rate endpoints, rare error counters), this produces persistent false zeros.

**False counter reset**: A counter at 1,000,000.5 rounds to 1,000,000 while the previous sample at 1,000,000.3 stays at 1,000,000.3. Since 1,000,000 < 1,000,000.3, the engine detects a reset and adds the **entire previous value** (1,000,000.3) to the cumulative correction. A 0.3-unit rounding error becomes a **1,000,000-unit error** in the rate calculation â€” an amplification factor equal to the counter's absolute magnitude.

The fix is an **epsilon-aware counter reset detector**. Instead of `current < previous`, use `current < previous - epsilon` where epsilon is derived from the storage precision metadata. For Float32 storage, epsilon at value V is approximately `V * 2^-23` (the Float32 machine epsilon). The query engine must carry precision metadata per series â€” stored as a `{precision: 'float64' | 'float32' | 'float16', compression: 'none' | 'sdt' | 'gorilla'}` tag alongside the label set â€” and consult it during counter operations.

### PromQL function sensitivity to lossy data

The full function catalog divides cleanly into four risk tiers:

**Critical risk** (must use lossless): `rate()`, `irate()`, `increase()`, and `resets()`. All depend on the `current < previous` comparison. `irate()` is especially dangerous because it uses only 2 samples â€” a single rounding error is catastrophic. `resets()` directly counts the number of `current < previous` transitions.

**High risk**: `changes()` (counts `current != previous` transitions â€” rounding merges distinct values, undercounting changes) and `stddev_over_time()` (squaring amplifies precision errors).

**Medium risk**: `histogram_quantile()` (linear interpolation within buckets â€” Prometheus already has a `1e-12` tolerance for monotonicity fixing, which could be extended to lossy precision), `delta()` and `idelta()` (linear error proportional to precision loss), and `quantile_over_time()` (relative ordering can change with rounding).

**Low/no risk**: `avg_over_time()` (averaging smooths noise), `min_over_time()` / `max_over_time()` (only affected at exact decision boundaries), `deriv()` and `predict_linear()` (linear regression smooths individual errors), and `absent()` / `absent_over_time()` (binary presence â€” completely unaffected by precision).

---

## Thanos AggrChunks provide the template for dual-mode tier storage

Thanos creates three resolution tiers â€” raw, 5-minute, and 1-hour â€” storing **five aggregates per series per interval**: min, max, sum, count, and counter. The counter aggregate is special: it stores both the first and last raw values within each downsampling window, with the last value encoded using a **duplicated timestamp** as a signal. The `ApplyCounterResetsSeriesIterator` compares the last value of chunk N with the first value of chunk N+1 to detect inter-window counter resets, enabling correct `rate()` computation on downsampled data.

All five aggregates are **incrementally computable in O(1)** per sample with O(1) state per window:

- `min = Math.min(current_min, new_value)`
- `max = Math.max(current_max, new_value)`
- `first` = set once, never changes
- `last` = always replaced with newest value
- `sum += new_value`; `count++`

They are also **fully mergeable**: two adjacent finalized windows combine in O(1) â€” `merged.min = min(w1.min, w2.min)`, `merged.first = w1.first`, `merged.last = w2.last`, etc. This property enables on-the-fly resolution adjustment without re-scanning.

For the browser engine, the recommended data structure per series is:

```
Tier 0 (Raw):    CircularBuffer<{t: int64, v: float64}>     // Last 10-30 min
Tier 1 (1-min):  CircularBuffer<AggregateWindow>             // Last 2-6 hours
Tier 2 (5-min):  CircularBuffer<AggregateWindow>             // Last 12-24 hours
Tier 3 (1-hour): CircularBuffer<AggregateWindow>             // Last 24 hours (24 entries)

AggregateWindow = {
  startTime: int64, endTime: int64,
  min: float64, max: float64,
  first: float64, last: float64,
  sum: float64, count: uint32,
  // For counters: firstRaw, lastRaw, totalIncrease, resetCount
}
```

Each new sample updates accumulators at **all four tiers simultaneously** â€” O(1) per tier, O(4) total. When a tier's window boundary is crossed, the accumulator is finalized, pushed to that tier's circular buffer, and reset. Memory per series at the aggregate tiers is fixed: an `AggregateWindow` is ~72 bytes, so Tier 3 (24 hourly entries) costs 1,728 bytes per series. At 100K series, that's **~165 MB** for all aggregate tiers combined â€” well within browser memory budgets.

**Resolution selection at query time** follows Thanos's heuristic: `max_resolution = step / 5`. For a dashboard panel requesting 6 hours of data at 1000px width, `step = 6*3600/1000 = 21.6s`, so `max_resolution = 4.3s` â†’ use raw data. For 24 hours at 1000px, `step = 86.4s` â†’ `max_resolution = 17.3s` â†’ use 1-minute aggregates. The M4 algorithm (Jugel et al., VLDB 2014) provides **mathematically error-free** line chart visualization by selecting exactly 4 points per pixel column (first, last, min, max) â€” which maps directly to the aggregate window fields.

Grafana Mimir, notably, does **not** implement downsampling â€” its compactor focuses exclusively on horizontal scaling via the split-and-merge strategy (sharding by series hash). This is a deliberate architectural choice, relying on query-time computation instead of pre-aggregation.

---

## Building blocks for PromQL evaluation exist but no evaluator does

**No PromQL evaluator exists in any browser-compatible language.** Only parsers exist. The most mature is `promql-parser` by GreptimeTeam (Rust, 376K+ crate downloads, compatible with Prometheus v3.8), which produces a complete AST and should compile cleanly to `wasm32-unknown-unknown` since it has no system dependencies. The `@qxip/promql-parser-js` npm package already demonstrates this compilation path, though it's marked experimental. On the JavaScript side, `@prometheus-io/lezer-promql` (official Prometheus project, stable, used in Prometheus UI and Grafana) provides a CodeMirror-compatible grammar that could serve as a parser foundation.

The Prometheus query engine's core data structures are:

- **Sample**: `{T: int64, F: float64, H: *FloatHistogram, Metric: Labels}`
- **Vector**: `[]Sample` â€” all samples share the same timestamp (instant query result)
- **Matrix**: `[]Series` â€” each Series has `Metric + []FPoint + []HPoint` (range query result)
- **Scalar**: single `float64` with timestamp

The evaluation model is a **recursive AST walk**: `VectorSelector` â†’ seek iterator to evaluation timestamp with lookback delta; `MatrixSelector` â†’ collect all samples in time window; `Call` â†’ evaluate arguments, dispatch to function implementation; `BinaryExpr` â†’ vector matching and label propagation; `AggregateExpr` â†’ group by labels, apply aggregation. The Thanos PromQL engine (`thanos-io/promql-engine`) uses a more sophisticated Volcano/Iterator model with logicalâ†’physical plan compilation and pluggable optimizers. Mimir's query engine (MQE) streams by series rather than by timestep, using less memory.

For the browser engine, the recommended path is: **compile `promql-parser` to WASM for parsing, build the evaluator in TypeScript** for maximum control over the JSâ†”WASM boundary and data access patterns. The evaluator in TypeScript can directly access JS-side ArrayBuffers without crossing the WASM boundary, and only invoke WASM for compute-heavy operations (decompression, aggregation over large ranges). This hybrid approach avoids the large binary size of compiling Go's PromQL engine to WASM (~10 MB+).

### The chunk iterator interface for dual-mode storage

The storage layer must expose an iterator compatible with the Prometheus pattern:

```typescript
interface ChunkIterator {
  next(): ValueType;              // ValNone | ValFloat | ValHistogram
  seek(t: number): ValueType;    // Advance to â‰¥ t
  at(): [number, number];        // [timestamp_ms, value]
  atT(): number;                 // timestamp only
  err(): Error | null;
}

interface Series {
  labels(): Labels;
  iterator(): ChunkIterator;
  metadata(): SeriesMetadata;     // precision, compression, resolution
}
```

The `SeriesMetadata` addition is the key extension for dual-mode storage. The query engine inspects `metadata().precision` before executing counter-sensitive functions and applies epsilon-aware comparisons when precision is below Float64.

**Apache Arrow RecordBatch** is a viable chunk format with strong ecosystem support â€” arrow-rs compiles to WASM (`arrow-wasm` by Dominik Moritz), and `apache-arrow` npm provides the JS side. Arrow's dictionary encoding handles labels efficiently, run-end encoding suits repeated values, and IPC compression (LZ4/ZSTD) achieves **7â€“12Ã— compression** on telemetry data. However, Arrow does not support streaming sample-at-a-time decompression â€” it operates on entire RecordBatches. The tradeoff: Arrow for bulk analytics and data interchange, Gorilla for interactive iterators.

---

## Ingestion, rendering, and the browser protocol stack

All pieces exist to implement OTLP and Prometheus Remote Write ingestion in the browser. **OTLP/HTTP** uses protobuf or JSON over HTTP POST; the `@opentelemetry/exporter-metrics-otlp-http` package explicitly supports browser usage with `fetch()`. **Prometheus Remote Write** requires protobuf encoding (`protobuf-es` by Buf â€” 62% smaller bundles than google-protobuf, fully conformance-tested) plus Snappy compression (`snappyjs` for pure JS at ~40â€“50% native speed, or `snappy-wasm` for better performance). Since browsers cannot listen on ports, ingestion requires either a **service worker** intercepting POSTs, a **WebSocket bridge** from a lightweight server-side relay, or periodic **pull** via Remote Read.

For rendering, **uPlot** (47.9 KB minified, ~9.6K GitHub stars) creates interactive charts with 150K data points in **135 ms**, scaling at ~25K pts/ms. Its columnar data format (`[timestamps[], values1[], values2[], ...]`) maps naturally to time series data. For streaming at ~60fps, the recommended pattern is pre-allocated Float64Arrays with `.subarray()` views and batched `setData()` calls. Beyond ~100K in-view points, performance degrades â€” but M4 downsampling to 4Ã— pixel width keeps the rendered dataset small regardless of retention depth.

Grafana's **DataFrame** model (based on Apache Arrow concepts) provides a well-designed reference: each `Field` has `name`, `type`, `values[]`, and optional `labels` (key-value pairs for dimensions). The "Multi format" â€” one frame per series with independent timestamps â€” is the only format handling misaligned timestamps, which is essential for heterogeneous scrape intervals.

---

## Testing against Prometheus ground truth

The **PromQL Compliance Tester** (PromLabs, `github.com/promlabs/promql-compliance-tester`) runs comparison tests between Prometheus and vendor implementations, with hundreds of test queries in `promql-test-queries.yml`. The **CNCF Prometheus Conformance Program** (`github.com/cncf/prometheus-conformance`) awards "PromQL YYYY-MM compliant" marks at 100% score, with Docker-based end-to-end tests.

The most valuable resource is `promtool test rules`, which uses a YAML format with **expanding notation** for time series (e.g., `0+10x5` = 0,10,20,30,40,50) and `promql_expr_test` blocks that specify expected sample values for arbitrary PromQL expressions. The Prometheus repo's `promql/promqltest/` directory contains hundreds of test cases covering rate(), increase(), histogram_quantile(), counter resets, and staleness handling. These test vectors are **directly extractable** as a portable test suite for any PromQL implementation.

For lossy-data-specific testing, the engine needs additional test cases: counter resets at Float32 precision boundaries (values near 2Â²â´ = 16,777,216), very small rates (Î” < Float32 epsilon Ã— counter value), rate() on SDT-compressed data with variable sample spacing, and histogram_quantile() on rate()-processed bucket counts that have been through Float32 rounding. The `fuzzy_compare` flag in promtool acknowledges Float64 precision issues and could be extended with configurable epsilon for lossy-aware comparison.

---

## Conclusion

The architecture that emerges from this research is a **three-layer system**: a TypeScript storage layer managing circular ArrayBuffers with Gorilla-compressed chunks and Thanos-style AggrChunk aggregates at multiple resolution tiers; a TypeScript PromQL evaluator built on `promql-parser` (Rustâ†’WASM) for parsing and the Prometheus iterator interface for data access; and a WASM compute layer with a fixed-size scratch buffer for batch decompression (ALP/Pcodec) and heavy aggregation. The evaluator carries `SeriesMetadata` through the evaluation tree, enabling epsilon-aware counter reset detection when processing lossy series.

The hardest unsolved problem is not compression or memory management but **semantic correctness of rate() on lossy counters**. The epsilon-aware approach works but requires careful calibration: too-large epsilon masks real resets, too-small epsilon allows false resets. For counters, the safest default is lossless storage with SDT dead-band filtering (which preserves monotonicity if the tolerance is set to 0 for counters â€” effectively only removing duplicate values). The lossy mode should be reserved for gauges and pre-aggregated data where the AggrChunk structure preserves query semantics by construction.

Memory budget at scale: 100K series Ã— (raw ring buffer of 120 samples at 16 bytes + 4 aggregate tiers at ~2 KB each) = **~1.1 GB** â€” feasible in a 4 GB wasm32 environment with JS-side storage, but tight. At 10K series the budget is ~110 MB, comfortable. The engine should use `navigator.deviceMemory` to auto-configure retention depth and compression aggressiveness at startup, defaulting to lossy gauges and lossless counters.