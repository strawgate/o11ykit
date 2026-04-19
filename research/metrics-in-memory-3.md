# Browser OTLP Metrics Engine: The Two Hard Problems

## Problem 1: WASM Memory Architecture

### The constraint is real but the proposed solution is wrong

WASM linear memory **cannot shrink**. This is confirmed â€” `memory.grow()` is
irreversible, there's no `memory.shrink()`, and DuckDB-WASM has filed bugs
about memory staying at ~2 GB after queries complete because "DuckDB frees the
memory, but the WASM worker does not." The SQLite-WASM team hit catastrophic
heap fragmentation after 280K operations.

But the proposed fix â€” "JS owns memory, WASM just computes" â€” **does not work
as described**. WASM cannot access external JS ArrayBuffers. There is no
`new WebAssembly.Memory(existingArrayBuffer)` constructor. GitHub issue
`WebAssembly/design#1162` ("Zero-copy pass ArrayBuffer from JS-land to
WebAssembly-land") has been open since 2017 with 49+ upvotes and no resolution.

### What actually works: the copy-in/compute/copy-out pattern

The viable architecture has three parts:

**1. JS owns all persistent data in TypedArrays.**

```typescript
// Per-series chunk ring buffer
class ChunkStore {
  // Each chunk: compressed bytes (Gorilla XOR encoded)
  private chunks: Map<SeriesId, CircularBuffer<Uint8Array>>;
  
  // Block aggregates: min, max, sum, count, first, last per chunk
  private aggregates: Map<SeriesId, CircularBuffer<Float64Array>>;
  
  // Eviction is free: just advance the ring buffer head pointer.
  // The old Uint8Array becomes unreferenced and GC collects it.
  evictOlderThan(cutoff: number) {
    for (const [id, ring] of this.chunks) {
      while (ring.peekOldest().maxTimestamp < cutoff) {
        ring.popOldest(); // GC handles the rest
      }
    }
  }
}
```

**2. WASM gets a fixed-size scratch buffer at startup, never grows.**

```rust
// In Rust/WASM â€” allocate once, reuse forever
const SCRATCH_SIZE: usize = 4 * 1024 * 1024; // 4 MB
static mut SCRATCH_IN: [u8; SCRATCH_SIZE] = [0u8; SCRATCH_SIZE];
static mut SCRATCH_OUT: [u8; SCRATCH_SIZE] = [0u8; SCRATCH_SIZE];

#[no_mangle]
pub extern "C" fn get_scratch_in_ptr() -> *mut u8 {
    unsafe { SCRATCH_IN.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn get_scratch_out_ptr() -> *const u8 {
    unsafe { SCRATCH_OUT.as_ptr() }
}
```

**3. JS copies chunk data into WASM scratch, calls compute, reads results back.**

```typescript
// JS side
const inPtr = wasm.get_scratch_in_ptr();
const inBuf = new Uint8Array(wasm.memory.buffer, inPtr, SCRATCH_SIZE);

// Copy compressed chunk into WASM scratch
inBuf.set(chunkBytes);

// WASM decompresses + computes (e.g., rate over range)
const resultLen = wasm.decompress_and_aggregate(
  chunkBytes.length,
  startTime,
  endTime,
  AggregateOp.RATE
);

// Read result back
const outPtr = wasm.get_scratch_out_ptr();
const outBuf = new Float64Array(wasm.memory.buffer, outPtr, resultLen / 8);
const result = outBuf.slice(0, resultLen / 8); // copy out
```

### Why this works for a metrics engine specifically

The copy cost is negligible because chunks are small. A Prometheus XOR chunk
holds ~120 samples at ~1.37 bytes/sample = **~165 bytes per chunk**. Even
copying 1000 chunks (all series for one scrape batch) = 165 KB, which takes
~0.1 ms at 2 GB/s memcpy throughput.

The key insight: **don't copy raw samples across the boundary â€” copy compressed
chunks and let WASM decompress + compute in one call.** The WASM side does:
decompress chunk â†’ iterate samples â†’ compute aggregate â†’ write scalar result.
One boundary crossing per chunk, not per sample.

### Memory budget

| Component | Location | Size (100K series, 1hr) |
|---|---|---|
| Compressed chunks (Gorilla XOR) | JS TypedArrays | ~12 MB |
| Block aggregates (48 bytes each) | JS Float64Arrays | ~2 MB |
| Label index (interned strings + posting lists) | JS Maps + arrays | ~5 MB |
| WASM scratch buffers | WASM linear memory | 8 MB (fixed) |
| WASM code + stack | WASM linear memory | ~2 MB |
| **Total** | | **~29 MB** |

WASM linear memory stays at **10 MB forever**. JS-side memory grows/shrinks
with data volume and GC handles eviction naturally.

### The memory.grow() trap and how to avoid it

Never call `memory.grow()` from Rust. Set initial memory large enough at
instantiation:

```javascript
const memory = new WebAssembly.Memory({ initial: 160 }); // 160 pages = 10 MB
const wasm = await WebAssembly.instantiate(module, {
  env: { memory }
});
```

If you do grow, **all existing TypedArray views are detached**:

```javascript
const view = new Uint8Array(wasm.memory.buffer); // valid
wasm.some_function_that_grows_memory();
// view is NOW INVALID â€” view.buffer is detached
const view2 = new Uint8Array(wasm.memory.buffer); // must recreate
```

This is the #1 cause of "memory access out of bounds" crashes in WASM apps.
The scratch-buffer pattern avoids it entirely because memory never grows.

---

## Problem 2: Building the PromQL Evaluator

### The rate() algorithm â€” exactly

This is the core of PromQL. Every counter operation (`rate`, `irate`,
`increase`, `resets`, `changes`) funnels through one function:
`extrapolatedRate`. Here is the complete algorithm, translated from
`prometheus/promql/functions.go`:

```
extrapolatedRate(samples, isCounter, isRate):
  if len(samples) < 2: return no result
  
  // 1. Counter reset compensation
  if isCounter:
    counterCorrection = 0
    for i in 1..len(samples):
      if samples[i].value < samples[i-1].value:
        // Reset detected! Add previous value to correction
        counterCorrection += samples[i-1].value
    // Apply correction to last value only
    resultValue = (samples[last].value - samples[first].value) + counterCorrection
  else:
    resultValue = samples[last].value - samples[first].value
  
  // 2. Extrapolation
  sampledInterval = samples[last].t - samples[first].t  // ms between first/last sample
  averageInterval = sampledInterval / (len(samples) - 1)
  
  // How far first/last samples are from window boundaries
  extrapolateToStart = averageInterval / 2  // default: half an interval
  extrapolateToEnd = averageInterval / 2
  
  // But: if first sample is close enough to window start, extrapolate fully
  durationToStart = (samples[first].t - windowStart) as float
  if durationToStart < averageInterval * 1.1:
    extrapolateToStart = durationToStart
  
  durationToEnd = (windowEnd - samples[last].t) as float
  if durationToEnd < averageInterval * 1.1:
    extrapolateToEnd = durationToEnd
  
  // Don't extrapolate counters below zero
  if isCounter and resultValue > 0 and samples[first].value >= 0:
    extrapolateToStart = min(extrapolateToStart,
                            sampledInterval * (samples[first].value / resultValue))
  
  // Scale result to cover full window
  factor = (sampledInterval + extrapolateToStart + extrapolateToEnd) / sampledInterval
  resultValue *= factor
  
  // 3. Convert to rate if needed
  if isRate:
    resultValue /= (windowEnd - windowStart) / 1000  // per-second
  
  return resultValue
```

That's it. `rate()` calls `extrapolatedRate(samples, isCounter=true, isRate=true)`.
`increase()` calls `extrapolatedRate(samples, isCounter=true, isRate=false)`.
`delta()` calls `extrapolatedRate(samples, isCounter=false, isRate=false)`.

`irate()` is simpler â€” it only uses the last 2 samples:

```
instantValue(samples, isRate):
  if len(samples) < 2: return no result
  prev = samples[len-2]
  last = samples[len-1]
  
  diff = last.value - prev.value
  if isRate and diff > 0 and last.value < prev.value:
    // counter reset
    diff = last.value
  
  if isRate:
    return diff / ((last.t - prev.t) / 1000)
  return diff
```

### The chunk iterator interface you must implement

Prometheus's query engine reads data through a specific iterator chain. You need
to implement this interface (translated to TypeScript):

```typescript
enum ValueType {
  None = 0,
  Float = 1,
  Histogram = 2,
  FloatHistogram = 3,
}

interface ChunkIterator {
  // Advance to the next sample. Returns the type of value, or None if exhausted.
  next(): ValueType;
  
  // Seek forward to the first sample at or after timestamp t.
  // Returns the type of value found, or None if no sample exists at or after t.
  seek(t: number): ValueType;
  
  // Return the current sample's timestamp and float value.
  // Only valid after next() or seek() returned ValueType.Float.
  at(): [number, number]; // [timestamp_ms, value]
  
  // Return just the timestamp (avoids decoding value when not needed).
  atT(): number;
  
  // Return any error that occurred during iteration.
  err(): Error | null;
}

// The series interface the query engine uses
interface Series {
  labels(): Labels;         // {__name__: "http_requests_total", method: "GET", ...}
  iterator(): ChunkIterator;
}

// The top-level query interface
interface Querier {
  // Select series matching the given label matchers
  select(sortSeries: boolean, matchers: LabelMatcher[]): SeriesSet;
}

interface SeriesSet {
  next(): boolean;         // advance to next series
  at(): Series;            // current series
  err(): Error | null;
  warnings(): string[];
}
```

### XOR chunk encoding â€” the exact byte layout

The first 2 bytes of a chunk are the **sample count** (big-endian uint16).
Then the bitstream:

```
Sample 0:
  timestamp: int64 raw (64 bits)
  value:     float64 raw (64 bits)

Sample 1:
  timestamp delta: int64 raw (64 bits) â€” delta from sample 0
  value XOR:
    if xor == 0: write 0 (1 bit) â€” value unchanged
    if leading/trailing zeros fit previous: write 10 + significant bits
    else: write 11 + 5 bits leading zeros + 6 bits significant count + significant bits

Sample 2+:
  timestamp delta-of-delta (variable width):
    if dod == 0:        write 0 (1 bit)
    if |dod| <= 2^6:    write 10 + sign + 6-bit magnitude
    if |dod| <= 2^13:   write 110 + sign + 13-bit magnitude  
    if |dod| <= 2^20:   write 1110 + sign + 20-bit magnitude
    else:               write 1111 + raw 64-bit dod
  value XOR: same as sample 1
```

This is a direct implementation of the Gorilla paper (Pelkonen et al., VLDB
2015). At 15-second scrape intervals, 96% of timestamp deltas-of-deltas are 0
(1 bit). ~51% of value XORs are 0 (1 bit). Average: **1.37 bytes/sample**.

### What to implement in WASM vs TypeScript

**In WASM (Rust):**
- XOR chunk encoder/decoder (the bitstream manipulation)
- Bulk decompression of a chunk into a Float64Array of [t, v, t, v, ...]
- `extrapolatedRate` computation on a decompressed sample array
- `min/max/sum/count/avg_over_time` on a decompressed sample array
- Future: ALP/FastLanes compression for background compaction

**In TypeScript:**
- PromQL parser (use `promql-parser` Rust crate compiled to WASM, or
  `@prometheus-io/lezer-promql` which is the official Prometheus JS parser
  used in the Prometheus UI and Grafana â€” stable, maintained, CodeMirror-based)
- Query engine evaluation tree walker
- Series selection (label matching against the posting list index)
- Vector matching and label propagation for binary ops
- Aggregation operators (sum/avg/min/max/count/topk/bottomk by label groups)
- Result formatting and handoff to chart renderer

The parser is small and fast enough in JS. The evaluator needs direct access to
the JS-side SeriesSet/ChunkStore â€” putting it in WASM would mean copying all
label strings across the boundary for every query, which is worse than doing
string matching in JS.

### The evaluation loop

For a range query like `rate(http_requests_total{method="GET"}[5m])`:

```
1. Parse: "rate(http_requests_total{method="GET"}[5m])"
   â†’ Call(rate, MatrixSelector(
       VectorSelector({__name__="http_requests_total", method="GET"}),
       range=5m
     ))

2. For each evaluation timestamp t in [start, end] step step:
   a. MatrixSelector: for each matching series,
      collect all samples in [t - 5m, t] via iterator.seek(t - 5m)
      then iterator.next() until timestamp > t
      
   b. Call rate(): apply extrapolatedRate() to the collected samples
      â†’ produces one float64 per series at timestamp t
      
   c. Emit Vector of (labels, timestamp, value) tuples

3. Collect all Vectors into a Matrix result
```

The critical optimization: **don't decompress chunks you don't need.** Each
chunk stores `minTimestamp` and `maxTimestamp` in its metadata. Before
decompressing, check if the chunk's time range overlaps the query window.
For a 5-minute rate query on a 24-hour dataset, you skip ~99% of chunks.

### Staleness handling

Prometheus marks a series as "stale" if no sample arrives within 5 minutes
(the "lookback delta"). The evaluator must handle this:

- A `VectorSelector` at time `t` returns the most recent sample in
  `[t - lookbackDelta, t]`. If none exists, the series is absent.
- Stale markers are special NaN values (`0x7FF0000000000002`). If the most
  recent sample is a stale marker, the series is absent even though a sample
  exists in the window.

### What `promql-parser` gives you (and what it doesn't)

The GreptimeTeam `promql-parser` crate (v0.4.2, Apache 2.0, compatible with
Prometheus v3.8) gives you a full AST:

```rust
pub enum Expr {
    Aggregate(AggregateExpr),
    Unary(UnaryExpr),
    Binary(BinaryExpr),
    Paren(ParenExpr),
    Subquery(SubqueryExpr),
    NumberLiteral(NumberLiteral),
    StringLiteral(StringLiteral),
    VectorSelector(VectorSelector),
    MatrixSelector(MatrixSelector),
    Call(Call),
    Extension(Extension),
}
```

It does NOT give you:
- An evaluator (you build this)
- A storage interface (you build this)
- Function implementations (you build rate/increase/etc.)
- Vector matching logic (you build this)

The crate has no system dependencies (no libc, no std::fs) so it should
compile to `wasm32-unknown-unknown` cleanly. Export a `parse(promql: &str) ->
Result<Expr, Error>` function, serialize the AST to JSON via serde, and
consume it in TypeScript.

Alternative: `@prometheus-io/lezer-promql` is a pure JS Lezer grammar that
produces a CST (concrete syntax tree). It's what Grafana uses for syntax
highlighting and autocompletion. Converting CST â†’ AST is ~200 lines of TS.
This avoids the WASM parser entirely and keeps the dependency chain simpler.

---

## Implementation Plan (ordered by what unblocks what)

### Phase 1: Storage layer (TypeScript, ~1 week)
- [ ] XOR chunk encoder/decoder in Rust, compiled to WASM
- [ ] `ChunkStore` with per-series circular buffers of compressed chunks
- [ ] `ChunkIterator` implementation that decompresses on `next()`/`seek()`
- [ ] Label index: `Map<string, Map<string, Uint32Array>>` (label name â†’ value â†’ series IDs)
- [ ] Label matcher: equality, regex, negative equality, negative regex

### Phase 2: OTLP ingestion (TypeScript, ~3 days)
- [ ] OTLP/HTTP JSON parser (no protobuf needed initially â€” JSON is simpler)
- [ ] Metric â†’ series mapping (metric name + attributes â†’ series ID)
- [ ] Counter vs gauge detection from OTLP metric type
- [ ] Sample appending to appropriate chunk

### Phase 3: Query engine (TypeScript, ~2 weeks)
- [ ] PromQL parser integration (lezer-promql or promql-parser via WASM)
- [ ] AST â†’ evaluation tree
- [ ] `VectorSelector` implementation with lookback delta + staleness
- [ ] `MatrixSelector` implementation
- [ ] `extrapolatedRate` (rate, irate, increase, delta, idelta, deriv)
- [ ] Aggregation over time (avg_over_time, min/max/sum/count_over_time)
- [ ] Aggregation operators (sum/avg/min/max/count by/without)
- [ ] Binary operators with vector matching

### Phase 4: Rendering (TypeScript, ~1 week)
- [ ] Query result â†’ uPlot data format conversion
- [ ] Streaming append for live data
- [ ] MinMaxLTTB downsampling for large time ranges

### Phase 5: WASM optimization (Rust, ~1 week)  
- [ ] Move hot-path decompression + aggregation to WASM
- [ ] Batch decompress API: one WASM call per chunk, not per sample
- [ ] SIMD-accelerated XOR decode (v128.xor)