# OTLP Metrics Engine â€” Research Plan

## What This Is

A client-side metrics computation engine that runs entirely in the browser.
It ingests OTLP JSON, stores it in a compressed columnar format, and serves
queries for visualization â€” no backend required. Think "SQLite for metrics"
but in the browser, purpose-built for OpenTelemetry.

Working name: **otel-engine** (or whatever you want).

---

## Core Tenets

These are non-negotiable design principles. Every decision gets tested
against them.

### 1. Zero-allocation hot paths

The ingestion and query paths must not create JS objects that pressure
the garbage collector. Typed arrays, pre-allocated scratch buffers,
and WASM for the parsing/decompression inner loops. If a hot path
calls `new`, that's a bug.

The reason this matters more here than in a server TSDB: browsers share
a single UI thread with rendering. GC pauses cause frame drops. A
dashboard that stutters every 5 seconds while ingesting live metrics
is broken, no matter how fast the p50 query latency is.

### 2. OTLP-native, not Prometheus-native

Every existing browser metrics tool bolts OTLP support onto a data model
designed for Prometheus exposition format. We go the other direction:
OTLP is the primary data model. Resource attributes, scope metadata,
all five metric types (gauge, sum, histogram, exponential histogram,
summary), aggregation temporality, exemplars â€” first-class citizens,
not afterthoughts.

This means our internal data model preserves OTLP semantics that
Prometheus discards: resource-level attributes as a separate dimension,
scope information, delta vs cumulative temporality as a queryable
property, histogram bucket boundaries as structured data.

### 3. Compression is not optional

Gorilla encoding with VictoriaMetrics's float-to-int optimization is
the baseline, not a feature flag. Every sample that enters the store
gets compressed into the chunk format. This isn't about saving memory
(though it does) â€” it's about cache locality. Compressed chunks mean
more data fits in L1/L2, which means faster scans.

### 4. The query engine streams, it does not materialize

Stolen directly from Mimir's MQE: never allocate arrays proportional
to total data size. Process chunk by chunk, series by series, fold
into fixed-size accumulators. A query over 100K series with 10K points
each should use the same ~2MB of scratch memory as a query over 100
series with 100 points.

### 5. Ship as a library, not an application

This is an npm package, not a dashboard. It provides a typed API that
returns `TimeSeries[]` â€” arrays of timestamps and values with label
maps. What you plug into ECharts, uPlot, Grafana Scenes, or your own
React components is your business. We provide chart adapters as
separate, optional packages.

---

## Unique Advantage

Where we win and why no one else does this.

### The only OTLP-native client-side metrics engine

Today, if you want to visualize OTLP metrics in the browser without
a backend, your options are:

1. **DuckDB-WASM + manual schema**: Parse OTLP JSON yourself, load
   into DuckDB tables, write SQL. Works but you're fighting a
   general-purpose OLAP engine with an 18MB WASM binary and no
   understanding of metric semantics (rate, histogram_quantile, etc).

2. **Prometheus + Grafana**: Run a full backend stack. Not client-side.

3. **Custom JS**: Parse JSON, store in arrays, write your own
   aggregation. Everyone does this ad-hoc, badly.

We are #3 done right â€” with production TSDB compression, streaming
query execution, and deep OTLP semantic awareness. Our total shipped
size should be **<100KB** (TS + WASM kernels) vs DuckDB-WASM's 18MB.

### Semantic awareness as a moat

Because we understand OTLP metric types, we can:

- Auto-apply `rate()` to monotonic sums (counters)
- Auto-apply `histogram_quantile()` to histogram metrics
- Handle delta-to-cumulative conversion transparently
- Detect counter resets and handle them correctly
- Preserve resource/scope metadata for multi-service correlation
- Render exemplars with trace context links

A user selects a metric name from a dropdown, and the engine already
knows how to query it correctly based on its OTLP type metadata.
No PromQL expertise required.

### Zero-infrastructure observability tools

This enables an entire category of tools that don't exist yet:

- CLI tools that dump OTLP JSON and open a browser-based explorer
- CI/CD pipelines that generate OTLP metrics reports as static HTML
- Embedded observability in desktop apps (Electron/Tauri)
- Offline-capable dashboards that work on an airplane
- Developer tools that visualize local OTel collector output
- Demo/playground environments for OTel libraries
- FastMCP's observability story â€” ship an inspector that
  visualizes MCP server metrics without requiring Grafana

---

## Where We Avoid Differentiating

Things we explicitly choose to be boring about.

### Query syntax

Use the builder API. Don't invent a query language. If we add a string
query syntax later, it should be a PromQL subset â€” don't be creative
here. People already know PromQL. The value is in the engine, not the
syntax. The builder API compiles to a `QueryPlan` IR that the engine
executes. This is an internal detail, not a user-facing innovation.

### Chart rendering

We output `TimeSeries[]`. We provide thin adapter functions for ECharts,
uPlot, and Plotly. We do not build our own chart library. We do not
have opinions about chart aesthetics. We absolutely do not build a
dashboard framework.

### Networking

We accept OTLP JSON as a string or ArrayBuffer. How it gets to the
browser (fetch, WebSocket, Server-Sent Events, pasted from clipboard)
is the caller's problem. We might provide a convenience wrapper for
the OTLP HTTP receiver endpoint format, but transport is out of scope.

### Persistence

In-memory only. If users want persistence across page loads, they can
use IndexedDB or localStorage to store compressed chunks â€” but we
don't build that layer. We might expose `serialize()`/`deserialize()`
on the chunk format, but durable storage is out of scope.

### Multi-tenancy, auth, clustering

No. This is a single-user, single-tab, in-process library.

---

## Research Agenda

### R1: Gorilla Compression in JS vs WASM â€” Quantified

**Question**: What is the actual throughput of Gorilla encode/decode
implemented in TypeScript vs a Zig WASM kernel, on real OTLP data?

**Method**:
- Implement Gorilla encoder/decoder in both TypeScript and Zig
- Generate realistic OTLP data: node_exporter-style gauges (CPU,
  memory, disk), HTTP request counters, histogram latencies
- Measure encode throughput (samples/sec), decode throughput,
  compression ratio (bits/sample), and peak memory
- Test with varying series characteristics: constant values,
  slowly changing, spiky, high-entropy random
- Profile GC pauses during sustained encoding in TS

**Expected outcome**: WASM decoder is 2-4x faster on throughput.
More importantly, WASM has zero GC jitter. The TS implementation
may be "fast enough" for small-to-medium workloads, which would
let us ship a pure-TS build with optional WASM acceleration.

**Stretch**: Benchmark the Chimp algorithm (VLDB 2022 improvement
over Gorilla that rebalances the flag bit encoding to better match
real-world XOR distributions â€” specifically, it optimizes for the
fact that trailing zeros are usually <6, which Gorilla wastes bits on).

### R2: VictoriaMetrics Floatâ†’Int Conversion â€” How Often Does It Help?

**Question**: What percentage of real-world OTLP metrics benefit from
the float-to-integer conversion, and what compression ratio improvement
does it yield?

**Method**:
- Collect OTLP JSON exports from real collectors (ask the community,
  use the OTel demo app, scrape a Kubernetes cluster)
- For each metric series, attempt floatâ†’int conversion at each scale
  factor (10^0 through 10^12)
- Measure: % of series that are pure integer, % that convert losslessly
  at each scale, compression ratio with/without conversion
- Also measure: does delta-encoding counters before XOR help in practice?

**Expected outcome**: 60-80% of series from typical infrastructure
monitoring are integers or convert losslessly at scale â‰¤3. Counter
delta-encoding should help dramatically for high-rate counters.

**This determines whether we implement int mode as a first-class
chunk encoding or defer it.**

### R3: Schema-Aware WASM JSON Parser â€” Real Speedup?

**Question**: Does a schema-aware OTLP JSON tokenizer in WASM
meaningfully beat `JSON.parse()` + JS tree walk for ingestion?

**Method**:
- Implement a Zig `std.json.Scanner`-based OTLP parser that emits
  directly to column buffers (no object graph)
- Benchmark against: (a) `JSON.parse()` + manual walk in JS,
  (b) a hand-written JS tokenizer that avoids `JSON.parse()`
- Measure: total ingestion latency (parse + flatten + append),
  GC pause frequency and duration during 60-second sustained
  ingestion at 10K points/sec
- Test on varying payload sizes: 10KB, 100KB, 1MB OTLP batches

**Expected outcome**: WASM is marginally faster on raw parse time
(maybe 1.5-2x). The real win is GC: zero pauses vs periodic 5-15ms
pauses from `JSON.parse()` object churn.

**Risk**: The cost of copying JSON bytes into WASM linear memory
might eat the parsing savings for small payloads. There's a crossover
point â€” find it.

**Alternative**: Instead of WASM, test whether a hand-rolled JS
streaming tokenizer (no `JSON.parse()`, manual char-by-char state
machine) achieves the same GC-free property. If so, WASM isn't
needed for ingestion and the pure-TS build covers this case.

### R4: Inverted Index Performance at Cardinality

**Question**: How does sorted-array intersection scale as series
cardinality grows from 1K to 1M?

**Method**:
- Implement the Prometheus-style MemPostings with galloping search
- Generate label sets with realistic cardinality distributions:
  10 label names, 5-500 unique values per label, power-law distribution
- Benchmark: single-label lookup, 2-label intersection, 3-label
  intersection, regex matching (=~)
- Compare: sorted Uint32Array + gallop vs Set intersection vs
  roaring bitmaps (there's a JS roaring bitmap library)

**Expected outcome**: Sorted arrays with galloping search win up to
~100K series. Beyond that, roaring bitmaps may be worth the complexity.
Most browser use cases are <100K series, so sorted arrays are likely
sufficient.

**Stretch**: If roaring bitmaps win convincingly, evaluate whether
a WASM roaring bitmap implementation (existing Rust crate compiled
to WASM) is worth the dependency.

### R5: Streaming Query Engine â€” Memory Profile

**Question**: What is the actual peak memory of streaming vs
materializing query execution?

**Method**:
- Implement both approaches for a realistic query: `sum by (endpoint)
  (rate(http.request.count[5m]))` over 10K series, 1-hour window,
  15-second step
- Materializing: decompress all chunks â†’ full Float64Array per series
  â†’ align all â†’ aggregate
- Streaming: chunk-at-a-time, fold into fixed accumulators
- Measure: peak heap via `performance.measureUserAgentSpecificMemory()`,
  total GC pause time, query latency

**Expected outcome**: Streaming uses 10-50x less peak memory. Latency
is similar or slightly better (better cache behavior from not
allocating huge arrays).

### R6: Web Worker Isolation â€” Is It Worth It?

**Question**: Does running the engine in a Web Worker meaningfully
improve UI responsiveness, and what is the cost of `postMessage`
serialization?

**Method**:
- Run the engine both in-thread and in a Worker
- Simulate a dashboard: ingest 1 batch/sec, run 4 queries/sec,
  render charts at 60fps
- Measure: frame drops (missed requestAnimationFrame), query
  latency (including serialization), total throughput

**Expected outcome**: Worker is strictly better for dashboards that
render at 60fps. The `postMessage` overhead for `TimeSeries[]` is
non-trivial but manageable if we transfer `Float64Array` buffers
(zero-copy via Transferable). The API design needs to account for
this â€” results must be returned as typed arrays, not plain objects.

**Key design decision**: If Worker isolation is necessary, it
constrains the API to be async and message-based. Better to know
this early.

### R7: OTLP Histogram and Exponential Histogram Performance

**Question**: How should histogram data be stored and queried
efficiently? Histograms are structurally different from scalar
metrics â€” each data point has variable-width bucket arrays.

**Method**:
- Profile real histogram data: typical bucket counts (8-20 for
  explicit, variable for exponential), update frequency, query
  patterns (percentile estimation, heatmap rendering)
- Evaluate storage options: flat 2D array (points Ã— buckets),
  columnar per-bucket arrays, Gorilla compression per bucket column
- Benchmark histogram_quantile computation: linear interpolation
  across merged bucket counts

**Expected outcome**: Histograms are 10-50x more expensive per data
point than scalars. Explicit histograms with fixed bucket boundaries
(the common case) compress well as columnar arrays because bucket
counts are correlated across time. Exponential histograms need special
handling due to variable scale factors.

**This is critical because histogram support is a key differentiator
over ad-hoc JS solutions.**

---

## Bleeding Edge Opportunities

Places where we can push beyond what production TSDBs do, because
our constraints (browser, in-memory, single-user) are different.

### E1: CompressionStream API for cold chunks

Browsers ship native `CompressionStream` (gzip/deflate/zstd in some
browsers). After Gorilla encoding, run the chunk bytes through
`CompressionStream` for an additional 30-50% compression on cold data.
This is VictoriaMetrics's ZSTD-on-top strategy, but using the browser's
native implementation â€” zero WASM, zero bundle size.

**Research**: Does `CompressionStream` support synchronous operation
or is it stream-only? Can we use it for small chunks (<1KB) without
excessive overhead? What's the latency for decompressing a 500-byte
Gorilla chunk through `DecompressionStream`?

### E2: SIMD in WASM for batch decompression

WebAssembly SIMD (128-bit, shipped in all major browsers) can
potentially accelerate Gorilla decompression. The bit-manipulation
inner loop isn't naturally SIMD-friendly, but the downstream operations
are: converting decoded timestamps from delta form to absolute
(`prefix_sum`), and applying transforms (rate calculation = adjacent
difference + divide).

**Research**: Implement SIMD-accelerated `prefix_sum` and `rate()`
in Zig targeting `@Vector(4, f64)`. Benchmark against scalar. The
Gorilla decode loop itself is sequential (each sample depends on the
previous), so it can't be parallelized â€” but everything downstream can.

### E3: SharedArrayBuffer for multi-tab dashboards

If multiple browser tabs need to query the same metrics data (common
in observability workflows â€” multiple dashboard panels in different
tabs), `SharedArrayBuffer` allows zero-copy sharing of the chunk store
across tabs/workers. The compressed chunks are immutable once frozen,
so there are no concurrency issues.

**Research**: What are the COOP/COEP requirements? How many real users
will have the correct headers set? Is the DX penalty worth the memory
savings?

### E4: Adaptive chunk sizing

Prometheus uses a fixed 120-sample chunk. But different series have
different characteristics:

- High-frequency, low-variance gauges (CPU utilization): benefit from
  larger chunks (more identical-value runs for XOR to exploit)
- Spiky counters (HTTP errors): benefit from smaller chunks (less
  wasted capacity during quiet periods, better range pruning)
- Histograms: different optimal size than scalars

**Research**: Implement adaptive chunk sizing that profiles each
series's compression characteristics during the first few chunks
and adjusts. Measure whether the complexity is worth the 10-20%
compression improvement.

### E5: Exemplar-linked trace context

OTLP metrics carry exemplars with trace IDs and span IDs. No
existing browser-side metrics tool does anything with these. We
could provide an API that, given a metric spike, returns the
associated exemplar trace IDs â€” enabling "click on a spike,
jump to the trace" without a backend.

**Research**: How common are exemplars in real OTLP data? What's
the storage overhead? Is it worth indexing them? This is more of
a product question than a technical one, but it's a unique
capability that nothing else offers client-side.

### E6: Incremental query with cursor-based resumption

For live dashboards, the typical pattern is: query the full visible
window on load, then incrementally append new data. Most engines
re-query the full window every refresh. We could instead maintain a
cursor per active query that knows which chunks have already been
processed, and only decompresses/aggregates newly-arrived chunks.

**Research**: What's the bookkeeping overhead of per-query cursors?
How does this interact with time-bucketed alignment (new data can
affect the current bucket's aggregation)? Is the complexity worth it
vs just re-querying the last 2-3 buckets?

### E7: WebGPU for heatmap rendering from histogram data

Histogram heatmaps (time Ã— bucket â†’ color intensity) are the most
compute-intensive visualization in observability. With 10K time buckets
Ã— 20 histogram buckets Ã— color mapping, you're computing 200K pixel
values. WebGPU compute shaders could do this directly from the
compressed chunk data, bypassing the CPU entirely.

**Research**: Is WebGPU adoption sufficient (Chrome yes, Firefox
behind a flag, Safari partial)? What's the overhead of uploading
chunk data to GPU memory? This is moonshot territory â€” only worth
exploring if histogram heatmaps become a key use case.

---

## Execution Sequence

What to build and benchmark, in order.

```
Phase 1: Core engine (weeks 1-4)
â”œâ”€â”€ String interner + series registry
â”œâ”€â”€ Gorilla encoder/decoder in TypeScript
â”œâ”€â”€ Per-series chunk storage with hot/warm tiers
â”œâ”€â”€ MemPostings inverted index
â”œâ”€â”€ Builder API â†’ QueryPlan â†’ streaming executor
â”œâ”€â”€ Basic transforms: rate, sum, avg, min, max, count
â”œâ”€â”€ TimeSeries[] output with ECharts/uPlot adapters
â”œâ”€â”€ R1 benchmark: Gorilla TS throughput + compression ratio
â””â”€â”€ R5 benchmark: streaming vs materializing memory profile

Phase 2: WASM acceleration (weeks 5-6)
â”œâ”€â”€ Zig WASM kernel: Gorilla decompressor
â”œâ”€â”€ Zig WASM kernel: schema-aware OTLP JSON tokenizer
â”œâ”€â”€ R3 benchmark: WASM parser vs JSON.parse
â”œâ”€â”€ R1 addendum: WASM decoder vs TS decoder
â””â”€â”€ Decision: ship pure-TS or require WASM

Phase 3: Advanced features (weeks 7-8)
â”œâ”€â”€ Histogram storage + histogram_quantile
â”œâ”€â”€ Delta-to-cumulative conversion
â”œâ”€â”€ Counter reset detection
â”œâ”€â”€ VM floatâ†’int chunk encoding
â”œâ”€â”€ R2 benchmark: int conversion benefit on real data
â”œâ”€â”€ R7 benchmark: histogram performance
â””â”€â”€ Eviction + memory management

Phase 4: Production hardening (weeks 9-10)
â”œâ”€â”€ Web Worker isolation + Transferable results
â”œâ”€â”€ R6 benchmark: Worker overhead
â”œâ”€â”€ Error handling, edge cases, fuzz testing
â”œâ”€â”€ Bundle size optimization (<100KB target)
â”œâ”€â”€ npm package, docs, examples
â””â”€â”€ R4 benchmark: index performance at scale

Phase 5: Bleeding edge (ongoing)
â”œâ”€â”€ E1: CompressionStream for cold chunks
â”œâ”€â”€ E2: SIMD batch operations
â”œâ”€â”€ E4: Adaptive chunk sizing
â”œâ”€â”€ E6: Incremental query cursors
â””â”€â”€ E5: Exemplar support
```

---

## Open Questions

Things I don't have a strong opinion on yet.

1. **Chunk size: 120 (Prometheus) vs 8192 (VictoriaMetrics)?**
   120 optimizes for fast range queries (less wasted decompression).
   8192 optimizes for compression ratio (more context for the predictor).
   In-browser, query latency matters more than storage â€” lean toward 120.
   But benchmark both.

2. **Should the WASM kernels be optional?**
   Pure-TS build works everywhere including environments where WASM
   is restricted (some CSPs). WASM build is faster but adds deployment
   complexity. Probably: ship both, auto-detect WASM support, fall back
   to TS.

3. **Do we handle out-of-order ingestion?**
   OTLP doesn't guarantee ordering. Prometheus and Mimir both added
   out-of-order support (it was painful). For a browser client receiving
   from a single collector, data is almost always in order. Probably:
   drop out-of-order samples initially, add a small reorder buffer later
   if users hit this in practice.

4. **What's the maximum target cardinality?**
   10K series is comfortable. 100K is achievable with care. 1M is
   probably beyond what makes sense in a browser. Setting an explicit
   target helps constrain index and memory management design.

5. **Do we ship the PromQL parser in v1?**
   The builder API is sufficient for programmatic use. PromQL string
   parsing is a convenience for power users. It's ~500 lines of
   recursive descent, not complex, but it's scope. Probably: v1.1.

6. **Name?** Something short that implies speed + metrics + browser.
   `metris`? `otel-lens`? `tinytsdb`? `chrono`?