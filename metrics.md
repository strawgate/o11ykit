# In-Memory OTLP Metrics Store â€” Technical Design

## Core Abstraction: The Time Series

Everything flows from one identity:

```
SeriesKey = hash(metric_name + sorted(all_attributes))
```

Where "all attributes" = resource attributes + scope attributes + data point attributes, flattened and sorted. Two data points with the same metric name and identical attribute sets belong to the same series.

Within a series: timestamps are monotonically increasing, values are temporally correlated, and the metric type + unit + temporality are fixed. All three properties are exploitable.

---

## 1. String Interning â€” The Foundation

Every string in OTLP repeats relentlessly. `service.name`, `http.method`, `GET`, `POST`, metric names â€” the same strings appear on every single data point. Storing them as JS strings means V8 allocates and GC-tracks millions of identical objects.

**Intern everything into a bidirectional lookup table:**

```typescript
class StringInterner {
  private strToId = new Map<string, number>();
  private idToStr: string[] = [];

  intern(s: string): number {
    let id = this.strToId.get(s);
    if (id === undefined) {
      id = this.idToStr.length;
      this.idToStr.push(s);
      this.strToId.set(s, id);
    }
    return id;
  }

  resolve(id: number): string {
    return this.idToStr[id];
  }
}
```

An OTLP attribute set `{ "service.name": "api", "method": "GET", "status": "200" }` becomes `Uint32Array [3, 7, 12, 42, 15, 88]` â€” six interned IDs (key-value pairs). This representation is:

- **Fixed width** â€” no variable-length string pointers
- **Hashable** â€” FNV-1a over the u32 array to get series identity
- **Comparable** â€” memcmp-equivalent for sorted attribute matching
- **~24 bytes** instead of ~200+ bytes of JS string objects + Map overhead

---

## 2. Series Registry

Maps series identity to a `SeriesId` (u32) and stores the series metadata once:

```typescript
interface SeriesDescriptor {
  id: number;                     // u32, assigned sequentially
  metricName: number;             // interned string ID
  metricType: MetricType;         // gauge | sum | histogram | exp_histogram | summary
  unit: number;                   // interned string ID
  temporality: AggTemporality;    // delta | cumulative (for sum/histogram)
  isMonotonic: boolean;           // for sum
  attributeIds: Uint32Array;      // interned key-value pairs, sorted by key
  resourceId: number;             // index into resource table (see below)
}

class SeriesRegistry {
  private descriptors: SeriesDescriptor[] = [];
  private keyToId = new Map<string, number>(); // hash(key) â†’ series ID

  // Resource-level dedup: many series share the same resource
  private resources: Uint32Array[] = [];       // interned attribute arrays
  private resourceKeyToId = new Map<string, number>();

  getOrCreate(
    metricName: number,
    metricType: MetricType,
    unit: number,
    temporality: AggTemporality,
    isMonotonic: boolean,
    resourceAttrs: Uint32Array,
    pointAttrs: Uint32Array,
  ): number {
    // Merge resource + point attrs, sort by key, hash
    const merged = mergeAndSortAttrs(resourceAttrs, pointAttrs);
    const key = seriesKeyHash(metricName, merged);

    let id = this.keyToId.get(key);
    if (id === undefined) {
      const resourceId = this.internResource(resourceAttrs);
      id = this.descriptors.length;
      this.descriptors.push({
        id, metricName, metricType, unit,
        temporality, isMonotonic,
        attributeIds: merged,
        resourceId,
      });
      this.keyToId.set(key, id);
    }
    return id;
  }
}
```

Typical cardinality: 1Kâ€“100K series. The registry itself is small.

---

## 3. Per-Series Chunk Storage (Gauge / Sum)

Each series owns a linked list of **chunks**. A chunk is a fixed-capacity block
of (timestamp, value) pairs stored in compressed TypedArrays.

### Chunk layout

```typescript
const CHUNK_CAPACITY = 1024; // data points per chunk â€” tune to L2 cache

class NumericChunk {
  // --- Timestamps: delta-of-delta encoding ---
  //
  // Raw timestamps (ns):  [1000, 1060, 1120, 1180, 1241]
  // Deltas:               [â€”,    60,   60,   60,   61  ]
  // Delta-of-delta:       [â€”,    â€”,    0,    0,    1   ]
  //
  // First timestamp stored raw. First delta stored raw.
  // Remaining as delta-of-delta in Int16Array (Â±32K range covers
  // jitter in regular scrape intervals). Overflows fall back to
  // a separate Int32Array overflow list.
  //
  t0: number;                        // first timestamp (ms, not ns â€” see note)
  tDelta0: number;                   // first delta
  tDeltaDeltas: Int16Array;          // delta-of-delta, capacity CHUNK_CAPACITY-2
  tOverflows: Map<number, number>;   // index â†’ full delta for overflow slots

  // --- Values: XOR float compression (Gorilla) ---
  //
  // For gauges/counters, consecutive values in a series are often
  // identical or differ only in low bits. XOR adjacent values:
  // if XOR = 0, store a single 0-bit. Otherwise store the XOR.
  //
  // In JS we can't do bit-packing efficiently, so we use a
  // practical approximation: value deduplication + delta encoding.
  //
  v0: number;                        // first value
  vDeltas: Float32Array;             // value[i] - value[i-1], f32 precision
  vDeltaOverflows: Map<number, number>; // index â†’ full f64 where f32 loses precision
  //
  // Why Float32Array for deltas? If values are similar (e.g., CPU
  // utilization 0.45, 0.46, 0.44...) the deltas are tiny and f32
  // is lossless for small deltas. The overflow map catches the
  // rare cases where f32 precision is insufficient.

  // --- Metadata ---
  length: number = 0;               // current fill level
  readonly capacity = CHUNK_CAPACITY;
  tMin: number = 0;                  // min timestamp (for range pruning)
  tMax: number = 0;                  // max timestamp (for range pruning)
  vMin: number = Infinity;           // min value (for range pruning)
  vMax: number = -Infinity;          // max value (for range pruning)

  // --- Decompression ---
  // Reconstruct full timestamp at index i:
  timestampAt(i: number): number {
    if (i === 0) return this.t0;
    let t = this.t0 + this.tDelta0;
    if (i === 1) return t;
    let delta = this.tDelta0;
    for (let j = 0; j < i - 1; j++) {
      const dod = this.tOverflows.has(j)
        ? this.tOverflows.get(j)!
        : this.tDeltaDeltas[j];
      delta += dod;
      t += delta;
    }
    return t;
  }

  // Bulk decompress all timestamps into a pre-allocated buffer:
  decompressTimestamps(out: Float64Array): void {
    out[0] = this.t0;
    if (this.length < 2) return;
    let delta = this.tDelta0;
    out[1] = this.t0 + delta;
    for (let i = 2; i < this.length; i++) {
      const dod = this.tOverflows.has(i - 2)
        ? this.tOverflows.get(i - 2)!
        : this.tDeltaDeltas[i - 2];
      delta += dod;
      out[i] = out[i - 1] + delta;
    }
  }

  // Bulk decompress all values:
  decompressValues(out: Float64Array): void {
    out[0] = this.v0;
    for (let i = 1; i < this.length; i++) {
      out[i] = this.vDeltaOverflows.has(i - 1)
        ? out[i - 1] + this.vDeltaOverflows.get(i - 1)!
        : out[i - 1] + this.vDeltas[i - 1];
    }
  }
}
```

### Timestamp precision note

OTLP uses nanoseconds (uint64 strings). JavaScript's `Number` is f64,
which has 53 bits of mantissa â€” enough for **millisecond** precision until
year 2255. Convert `timeUnixNano` to **milliseconds** on ingest:
`ts_ms = parseInt(timeUnixNano) / 1_000_000`. This loses sub-ms precision
but chart libraries don't render sub-ms anyway. Store as f64.

If you need nanosecond fidelity for rate calculations, store the original
nano offset from chunk start as a Uint32Array (up to ~4.29s range per chunk,
sufficient for 1024 points at typical scrape intervals).

### Compression ratios

For a typical 15-second scrape interval gauge series with slowly-changing values:

| Field | Raw (per point) | Compressed (per point) | Ratio |
|-------|-----------------|----------------------|-------|
| Timestamp | 8 bytes (f64) | 2 bytes (Int16 DoD) | 4x |
| Value | 8 bytes (f64) | 4 bytes (Float32 delta) | 2x |
| **Total** | **16 bytes** | **6 bytes** | **2.7x** |

With 100K active series Ã— 1024 points Ã— 6 bytes = **~580 MB** compressed
vs. **~1.56 GB** raw. For most dashboards looking at 1â€“6 hour windows,
you're looking at **10Kâ€“50K series Ã— 240â€“1440 points = 14â€“43 MB compressed**.

---

## 4. Histogram Chunk Storage

Histograms are structurally different â€” each data point has variable-width
bucket arrays. Store them separately:

```typescript
class HistogramChunk {
  // Timestamps â€” same delta-of-delta as NumericChunk
  t0: number;
  tDelta0: number;
  tDeltaDeltas: Int16Array;
  tOverflows: Map<number, number>;

  // Histogram-specific: bucket boundaries are constant within a series
  explicitBounds: Float64Array;       // e.g., [5, 10, 25, 50, 100, 250, 500, 1000]
  numBuckets: number;                 // bounds.length + 1

  // Per-point aggregates
  counts: Float64Array;               // total count per point
  sums: Float64Array;                 // total sum per point
  mins: Float64Array;                 // min per point (optional in OTLP)
  maxes: Float64Array;                // max per point

  // Bucket counts: stored as a flat 2D array
  // Layout: [point0_bucket0, point0_bucket1, ..., point1_bucket0, ...]
  bucketCounts: Float64Array;         // length = numPoints Ã— numBuckets

  // For DELTA temporality, store raw. For CUMULATIVE, delta-encode
  // across time (bucket_counts[i] - bucket_counts[i-1]) since
  // cumulative buckets are monotonically increasing and deltas
  // compress better.

  length: number = 0;
  tMin: number = 0;
  tMax: number = 0;

  // Access bucket counts for point i:
  getBuckets(i: number): Float64Array {
    const offset = i * this.numBuckets;
    return this.bucketCounts.subarray(offset, offset + this.numBuckets);
  }
}
```

Exponential histograms get their own chunk type with `scale`, `zeroCount`,
and positive/negative bucket arrays. These are rare enough in practice
that a simpler (less compressed) storage is fine.

---

## 5. Series Store â€” Tying It Together

```typescript
class SeriesStore {
  // One entry per series â€” the hot path
  private chunks: Map<number, NumericChunk[]> = new Map();       // seriesId â†’ chunks
  private histChunks: Map<number, HistogramChunk[]> = new Map(); // seriesId â†’ chunks

  // Active (append-target) chunk per series
  private activeChunk: Map<number, NumericChunk> = new Map();
  private activeHistChunk: Map<number, HistogramChunk> = new Map();

  append(seriesId: number, timestamp: number, value: number): void {
    let chunk = this.activeChunk.get(seriesId);
    if (!chunk || chunk.length >= chunk.capacity) {
      chunk = new NumericChunk();
      this.activeChunk.set(seriesId, chunk);
      if (!this.chunks.has(seriesId)) this.chunks.set(seriesId, []);
      this.chunks.get(seriesId)!.push(chunk);
    }
    chunk.append(timestamp, value); // handles delta encoding internally
  }

  appendHistogram(seriesId: number, timestamp: number, hist: HistogramPoint): void {
    // Similar, but into HistogramChunk
  }

  // Range query: return all chunks for a series that overlap [tMin, tMax]
  getChunksInRange(seriesId: number, tMin: number, tMax: number): NumericChunk[] {
    const all = this.chunks.get(seriesId) ?? [];
    return all.filter(c => c.tMax >= tMin && c.tMin <= tMax);
  }
}
```

---

## 6. Indexes

Three index types cover all query patterns:

### 6a. Metric Name Index

```typescript
// metricNameId â†’ Set<seriesId>
// "Which series belong to metric http.request.duration?"
class MetricIndex {
  private index = new Map<number, Set<number>>();

  add(metricNameId: number, seriesId: number): void {
    let set = this.index.get(metricNameId);
    if (!set) { set = new Set(); this.index.set(metricNameId, set); }
    set.add(seriesId);
  }

  getSeries(metricNameId: number): Set<number> {
    return this.index.get(metricNameId) ?? new Set();
  }
}
```

### 6b. Attribute Inverted Index

```typescript
// (attrKeyId, attrValueId) â†’ Set<seriesId>
// "Which series have method=GET?"
class AttributeIndex {
  // Composite key: (keyId << 16) | valueId â€” works for up to 65K unique values per key
  private index = new Map<number, Set<number>>();

  add(keyId: number, valueId: number, seriesId: number): void {
    const compositeKey = (keyId << 16) | valueId;
    let set = this.index.get(compositeKey);
    if (!set) { set = new Set(); this.index.set(compositeKey, set); }
    set.add(seriesId);
  }

  // Filter: method=GET â†’ intersect with metric index results
  getSeries(keyId: number, valueId: number): Set<number> {
    return this.index.get((keyId << 16) | valueId) ?? new Set();
  }

  // Enumerate all values for a key (for UI dropdowns)
  getValues(keyId: number): number[] {
    const values: number[] = [];
    for (const [composite] of this.index) {
      if ((composite >> 16) === keyId) values.push(composite & 0xFFFF);
    }
    return values;
  }
}
```

### 6c. Time Range Index (per-series)

Already built into the chunk structure â€” each chunk has `tMin`/`tMax`.
Chunks are ordered by time within a series, so binary search finds
the first overlapping chunk in O(log n).

### Composite query resolution

```typescript
// Query: http.request.duration{service="api", method="GET"}
function resolveSeriesIds(
  metricIndex: MetricIndex,
  attrIndex: AttributeIndex,
  interner: StringInterner,
  metricName: string,
  filters: { key: string; op: '=' | '!='; value: string }[],
): Set<number> {
  const nameId = interner.intern(metricName);
  let candidates = metricIndex.getSeries(nameId);

  for (const f of filters) {
    const keyId = interner.intern(f.key);
    const valId = interner.intern(f.value);
    const matching = attrIndex.getSeries(keyId, valId);
    if (f.op === '=') {
      candidates = intersect(candidates, matching);
    } else {
      candidates = difference(candidates, matching);
    }
  }
  return candidates;
}
```

This is O(n) in the smaller set for intersect â€” typically milliseconds
even for 100K series since set operations are native V8.

---

## 7. Ingestion Pipeline

### 7a. Batch Ingestion (initial load)

```typescript
interface IngestStats {
  pointsIngested: number;
  seriesCreated: number;
  bytesProcessed: number;
  durationMs: number;
}

class MetricsEngine {
  private interner = new StringInterner();
  private registry = new SeriesRegistry();
  private store = new SeriesStore();
  private metricIndex = new MetricIndex();
  private attrIndex = new AttributeIndex();

  ingestOtlpBatch(json: string): IngestStats {
    const t0 = performance.now();
    const payload = JSON.parse(json); // V8's C++ JSON.parse â€” fast
    let pointCount = 0;
    let newSeries = 0;

    for (const rm of payload.resourceMetrics ?? []) {
      // Intern resource attributes once per ResourceMetrics
      const resourceAttrs = this.internAttributes(rm.resource?.attributes);

      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const metricNameId = this.interner.intern(metric.name);
          const unitId = this.interner.intern(metric.unit ?? '');
          const { type, points, temporality, isMonotonic } =
            this.extractMetricData(metric);

          for (const dp of points) {
            const pointAttrs = this.internAttributes(dp.attributes);
            const seriesId = this.registry.getOrCreate(
              metricNameId, type, unitId, temporality, isMonotonic,
              resourceAttrs, pointAttrs,
            );

            // Index (idempotent â€” Set deduplicates)
            if (!this.metricIndex.getSeries(metricNameId).has(seriesId)) {
              newSeries++;
              this.metricIndex.add(metricNameId, seriesId);
              this.indexAttributes(resourceAttrs, seriesId);
              this.indexAttributes(pointAttrs, seriesId);
            }

            // Store
            const ts = parseInt(dp.timeUnixNano) / 1_000_000; // â†’ ms
            if (type === MetricType.Histogram) {
              this.store.appendHistogram(seriesId, ts, dp);
            } else {
              const value = dp.asDouble ?? parseInt(dp.asInt ?? '0');
              this.store.append(seriesId, ts, value);
            }
            pointCount++;
          }
        }
      }
    }

    return {
      pointsIngested: pointCount,
      seriesCreated: newSeries,
      bytesProcessed: json.length,
      durationMs: performance.now() - t0,
    };
  }

  private internAttributes(attrs?: OtlpKeyValue[]): Uint32Array {
    if (!attrs?.length) return new Uint32Array(0);
    // Sort by key for deterministic hashing
    const sorted = [...attrs].sort((a, b) => a.key.localeCompare(b.key));
    const ids = new Uint32Array(sorted.length * 2);
    for (let i = 0; i < sorted.length; i++) {
      ids[i * 2] = this.interner.intern(sorted[i].key);
      ids[i * 2 + 1] = this.interner.intern(
        extractStringValue(sorted[i].value)
      );
    }
    return ids;
  }

  private indexAttributes(attrs: Uint32Array, seriesId: number): void {
    for (let i = 0; i < attrs.length; i += 2) {
      this.attrIndex.add(attrs[i], attrs[i + 1], seriesId);
    }
  }

  private extractMetricData(metric: any) {
    if (metric.gauge) return {
      type: MetricType.Gauge,
      points: metric.gauge.dataPoints,
      temporality: AggTemporality.Unspecified,
      isMonotonic: false,
    };
    if (metric.sum) return {
      type: MetricType.Sum,
      points: metric.sum.dataPoints,
      temporality: metric.sum.aggregationTemporality ?? 0,
      isMonotonic: metric.sum.isMonotonic ?? false,
    };
    if (metric.histogram) return {
      type: MetricType.Histogram,
      points: metric.histogram.dataPoints,
      temporality: metric.histogram.aggregationTemporality ?? 0,
      isMonotonic: false,
    };
    // exponentialHistogram, summary ...
    throw new Error(`Unknown metric type for ${metric.name}`);
  }
}
```

### 7b. Incremental Ingestion (streaming updates)

Same code path as batch â€” `ingestOtlpBatch` is idempotent. Series identity
lookup is a hash map hit (O(1)), chunk append is O(1) amortized.

For real-time streaming, buffer incoming payloads and flush every 100ms
or 1000 points, whichever comes first. This amortizes JSON.parse overhead
and keeps chunk fill factors high:

```typescript
class IngestBuffer {
  private pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: number | null = null;

  push(otlpJson: string): void {
    this.pending.push(otlpJson);
    this.pendingBytes += otlpJson.length;

    if (this.pendingBytes > 512_000) { // 512KB threshold
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;

    // Merge into single OTLP structure to batch-ingest
    const merged = {
      resourceMetrics: this.pending.flatMap(
        json => JSON.parse(json).resourceMetrics ?? []
      ),
    };
    engine.ingestOtlpBatch(JSON.stringify(merged));

    this.pending = [];
    this.pendingBytes = 0;
  }
}
```

### 7c. Deduplication

OTLP doesn't guarantee exactly-once delivery. Handle duplicates:

```typescript
// Per-series, track last ingested timestamp
class SeriesStore {
  private lastTimestamp = new Map<number, number>();

  append(seriesId: number, timestamp: number, value: number): boolean {
    const last = this.lastTimestamp.get(seriesId) ?? -Infinity;
    if (timestamp <= last) return false; // duplicate or out-of-order â€” drop
    this.lastTimestamp.set(seriesId, timestamp);
    // ... append to chunk
    return true;
  }
}
```

---

## 8. Query Execution Engine

### 8a. Query Plan

```typescript
interface QueryPlan {
  metric: string;
  filters: { key: string; op: '=' | '!='; value: string }[];
  timeRange: [number, number]; // ms
  step: number;                // bucket width in ms
  pipeline: TransformStep[];
  groupBy?: string[];          // attribute keys
}

type TransformStep =
  | { type: 'rate' }
  | { type: 'aggregate'; op: 'sum' | 'avg' | 'min' | 'max' | 'count' }
  | { type: 'percentile'; p: number }
  | { type: 'histogram_quantile'; q: number }
  | { type: 'topk'; k: number; by: 'avg' | 'max' }
  | { type: 'math'; op: '+' | '-' | '*' | '/'; value: number }
```

### 8b. Execution

```typescript
interface TimeSeries {
  labels: Record<string, string>;
  timestamps: Float64Array;
  values: Float64Array;
}

class QueryExecutor {
  execute(plan: QueryPlan, engine: MetricsEngine): TimeSeries[] {
    // 1. Resolve matching series
    const seriesIds = resolveSeriesIds(
      engine.metricIndex, engine.attrIndex, engine.interner,
      plan.metric, plan.filters,
    );

    // 2. For each series, extract raw (t, v) in time range
    const rawSeries: { id: number; t: Float64Array; v: Float64Array }[] = [];
    for (const sid of seriesIds) {
      const { timestamps, values } = engine.store.decompress(
        sid, plan.timeRange[0], plan.timeRange[1],
      );
      if (timestamps.length > 0) {
        rawSeries.push({ id: sid, t: timestamps, v: values });
      }
    }

    // 3. Time-align into step buckets
    const numBuckets = Math.ceil(
      (plan.timeRange[1] - plan.timeRange[0]) / plan.step
    );
    const bucketTimestamps = new Float64Array(numBuckets);
    for (let i = 0; i < numBuckets; i++) {
      bucketTimestamps[i] = plan.timeRange[0] + i * plan.step;
    }

    let aligned = rawSeries.map(s => ({
      id: s.id,
      timestamps: bucketTimestamps,
      values: alignToBuckets(s.t, s.v, bucketTimestamps, plan.step),
    }));

    // 4. Apply transform pipeline
    for (const step of plan.pipeline) {
      aligned = this.applyTransform(step, aligned, plan);
    }

    // 5. Group-by (if specified) â€” merge series with same group key
    if (plan.groupBy?.length) {
      aligned = this.applyGroupBy(aligned, plan.groupBy, engine);
    }

    // 6. Build output
    return aligned.map(s => ({
      labels: engine.registry.getLabels(s.id, engine.interner),
      timestamps: s.timestamps,
      values: s.values,
    }));
  }
}
```

### 8c. Bucket Alignment

The core of time-series query: map raw irregularly-spaced points into
fixed-width time buckets.

```typescript
function alignToBuckets(
  rawT: Float64Array,
  rawV: Float64Array,
  bucketStarts: Float64Array,
  step: number,
): Float64Array {
  const out = new Float64Array(bucketStarts.length).fill(NaN);
  let ri = 0; // raw index

  for (let bi = 0; bi < bucketStarts.length; bi++) {
    const bStart = bucketStarts[bi];
    const bEnd = bStart + step;
    let sum = 0, count = 0, last = NaN;

    // Advance raw pointer to this bucket
    while (ri < rawT.length && rawT[ri] < bStart) ri++;

    // Collect all raw points in [bStart, bEnd)
    const riStart = ri;
    while (ri < rawT.length && rawT[ri] < bEnd) {
      sum += rawV[ri];
      last = rawV[ri];
      count++;
      ri++;
    }
    ri = riStart; // reset â€” next bucket may overlap for interpolation

    // Default alignment: last value in bucket (instant vector semantics)
    out[bi] = count > 0 ? last : NaN;

    // For rate() pre-processing, we'll want sum/count instead
    // This gets overridden by the transform pipeline
  }

  // Second pass: advance raw pointer properly
  // (simplified above â€” production version uses a single forward scan)

  return out;
}
```

### 8d. Transform Implementations

```typescript
function applyRate(
  values: Float64Array,
  step: number, // ms
): Float64Array {
  const out = new Float64Array(values.length);
  out[0] = NaN; // rate needs two points
  const stepSec = step / 1000;
  for (let i = 1; i < values.length; i++) {
    if (isNaN(values[i]) || isNaN(values[i - 1])) {
      out[i] = NaN;
    } else {
      const delta = values[i] - values[i - 1];
      out[i] = delta >= 0
        ? delta / stepSec
        : values[i] / stepSec; // counter reset
    }
  }
  return out;
}

function aggregateAcrossSeries(
  seriesList: { values: Float64Array }[],
  op: 'sum' | 'avg' | 'min' | 'max' | 'count',
): Float64Array {
  if (seriesList.length === 0) return new Float64Array(0);
  const len = seriesList[0].values.length;
  const out = new Float64Array(len);

  for (let i = 0; i < len; i++) {
    let acc = op === 'min' ? Infinity : op === 'max' ? -Infinity : 0;
    let count = 0;

    for (const s of seriesList) {
      const v = s.values[i];
      if (isNaN(v)) continue;
      count++;
      switch (op) {
        case 'sum': case 'avg': acc += v; break;
        case 'min': acc = Math.min(acc, v); break;
        case 'max': acc = Math.max(acc, v); break;
        case 'count': acc++; break;
      }
    }

    out[i] = count === 0 ? NaN :
             op === 'avg' ? acc / count : acc;
  }
  return out;
}

// histogram_quantile: given histogram bucket counts and bounds,
// compute the estimated quantile using linear interpolation
// (same algorithm as Prometheus)
function histogramQuantile(
  q: number,
  bucketCounts: Float64Array, // cumulative counts per bucket
  bounds: Float64Array,       // explicit bounds (len = bucketCounts.len - 1)
): number {
  const total = bucketCounts[bucketCounts.length - 1];
  if (total === 0) return NaN;
  const rank = q * total;

  for (let i = 0; i < bucketCounts.length; i++) {
    if (bucketCounts[i] >= rank) {
      const lower = i > 0 ? bounds[i - 1] : 0;
      const upper = i < bounds.length ? bounds[i] : lower;
      const countInBucket = bucketCounts[i] - (i > 0 ? bucketCounts[i - 1] : 0);
      if (countInBucket === 0) return lower;
      const rankInBucket = rank - (i > 0 ? bucketCounts[i - 1] : 0);
      return lower + (upper - lower) * (rankInBucket / countInBucket);
    }
  }
  return bounds[bounds.length - 1];
}
```

---

## 9. Memory Management & Eviction

```typescript
class MemoryManager {
  private maxBytes: number;

  constructor(maxMB: number = 512) {
    this.maxBytes = maxMB * 1024 * 1024;
  }

  // Estimate current memory usage
  estimateUsage(store: SeriesStore): number {
    let bytes = 0;
    for (const [, chunks] of store.chunks) {
      for (const chunk of chunks) {
        // Int16Array: 2 bytes * capacity
        // Float32Array: 4 bytes * capacity
        // Overhead: ~100 bytes per chunk
        bytes += chunk.capacity * 6 + 100;
        bytes += chunk.tOverflows.size * 12;
        bytes += chunk.vDeltaOverflows.size * 12;
      }
    }
    for (const [, chunks] of store.histChunks) {
      for (const chunk of chunks) {
        bytes += chunk.numBuckets * chunk.capacity * 8; // bucket counts
        bytes += chunk.capacity * 32;                    // aggregates
        bytes += 100;
      }
    }
    return bytes;
  }

  // Evict oldest chunks until under budget
  evict(store: SeriesStore): number {
    let freed = 0;
    const usage = this.estimateUsage(store);
    if (usage <= this.maxBytes) return 0;
    const target = this.maxBytes * 0.8; // evict to 80% to avoid thrashing

    // Collect all chunks with their timestamps
    const evictable: { seriesId: number; chunkIdx: number; tMax: number; bytes: number }[] = [];
    for (const [seriesId, chunks] of store.chunks) {
      for (let i = 0; i < chunks.length - 1; i++) { // never evict active chunk
        evictable.push({
          seriesId, chunkIdx: i,
          tMax: chunks[i].tMax,
          bytes: chunks[i].capacity * 6 + 100,
        });
      }
    }

    // Sort oldest first
    evictable.sort((a, b) => a.tMax - b.tMax);

    let current = usage;
    for (const e of evictable) {
      if (current <= target) break;
      store.removeChunk(e.seriesId, e.chunkIdx);
      current -= e.bytes;
      freed += e.bytes;
    }

    return freed;
  }
}
```

---

## 10. Alternative Compression: ArrayBuffer Pooling

For maximum memory efficiency, avoid per-chunk typed array allocations
(each TypedArray has ~64 bytes of V8 overhead). Instead, allocate large
ArrayBuffer slabs and create views:

```typescript
class BufferPool {
  private slab: ArrayBuffer;
  private offset = 0;

  constructor(sizeMB: number = 16) {
    this.slab = new ArrayBuffer(sizeMB * 1024 * 1024);
  }

  allocFloat64(count: number): Float64Array {
    const byteLen = count * 8;
    const aligned = (this.offset + 7) & ~7; // 8-byte align
    if (aligned + byteLen > this.slab.byteLength) {
      // Allocate new slab, chain to previous
      this.slab = new ArrayBuffer(this.slab.byteLength);
      this.offset = 0;
      return this.allocFloat64(count);
    }
    const view = new Float64Array(this.slab, aligned, count);
    this.offset = aligned + byteLen;
    return view;
  }

  allocInt16(count: number): Int16Array {
    const byteLen = count * 2;
    const aligned = (this.offset + 1) & ~1;
    if (aligned + byteLen > this.slab.byteLength) {
      this.slab = new ArrayBuffer(this.slab.byteLength);
      this.offset = 0;
      return this.allocInt16(count);
    }
    const view = new Int16Array(this.slab, aligned, count);
    this.offset = aligned + byteLen;
    return view;
  }

  // Segment-level reset: when evicting a slab's worth of old data,
  // just drop the reference. GC handles the rest.
}
```

This reduces per-chunk overhead from ~128 bytes (two TypedArray objects)
to ~0 bytes (views into shared slab). For 10K chunks, that's 1.2 MB
saved in object overhead alone.

---

## 11. Full Architecture Summary

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  OTLP JSON Input                                           â”‚
â”‚  (batch or streaming)                                      â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â”‚
                      â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  IngestBuffer                        â”‚
â”‚  - Batches small payloads            â”‚
â”‚  - Flush on size/time threshold      â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â”‚
                      â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Ingestion Pipeline                  â”‚
â”‚  1. JSON.parse (V8 native)           â”‚
â”‚  2. String interning                 â”‚
â”‚  3. Series identity resolution       â”‚
â”‚  4. Index updates                    â”‚
â”‚  5. Chunk append (compressed)        â”‚
â”‚  6. Dedup check                      â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â”‚
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â–¼             â–¼             â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ String   â”‚  â”‚ Series   â”‚  â”‚ Series   â”‚
â”‚ Interner â”‚  â”‚ Registry â”‚  â”‚ Store    â”‚
â”‚          â”‚  â”‚          â”‚  â”‚          â”‚
â”‚ strâ†”u32  â”‚  â”‚ idâ†’desc  â”‚  â”‚ Numeric  â”‚
â”‚ bidir    â”‚  â”‚ keyâ†’id   â”‚  â”‚ Chunks   â”‚
â”‚ map      â”‚  â”‚ resource â”‚  â”‚ (DoD+Î”)  â”‚
â”‚          â”‚  â”‚ dedup    â”‚  â”‚          â”‚
â”‚          â”‚  â”‚          â”‚  â”‚ Histo    â”‚
â”‚          â”‚  â”‚          â”‚  â”‚ Chunks   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜
                                 â”‚
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  Indexes                       â”‚
â”‚  â”œâ”€ MetricIndex: nameâ†’{sid}    â”‚
â”‚  â”œâ”€ AttrIndex: (k,v)â†’{sid}    â”‚
â”‚  â””â”€ TimeRange: per-chunk min/max
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â”‚
                      â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Query Executor                      â”‚
â”‚  1. Resolve series (indexes)         â”‚
â”‚  2. Decompress chunks in range       â”‚
â”‚  3. Align to time buckets            â”‚
â”‚  4. Apply transform pipeline         â”‚
â”‚  5. Group-by aggregation             â”‚
â”‚  6. Return TimeSeries[]              â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â”‚
                      â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Chart Adapters                      â”‚
â”‚  toECharts() | toUPlot() | toPlotly()â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### Memory budget for a typical dashboard scenario

| Component | Scenario | Memory |
|-----------|----------|--------|
| 10K series Ã— 1K points compressed | 3-hour window, 10s interval | ~60 MB |
| String interner (5K unique strings) | | ~0.5 MB |
| Series registry (10K entries) | | ~2 MB |
| Indexes | | ~4 MB |
| Decompression scratch buffers | | ~8 MB |
| **Total** | | **~75 MB** |

This fits comfortably in browser memory with room for 4-8x growth
before hitting the 512 MB eviction ceiling.

### Ingestion throughput estimate

- JSON.parse: ~200 MB/s in V8 for OTLP-shaped JSON
- String interning: ~5M ops/s (Map.get is O(1))
- Series resolution: ~2M ops/s (hash + Map.get)
- Chunk append: ~10M ops/s (typed array write + delta math)
- **Bottleneck**: JSON.parse â†’ ~50K points/sec for typical OTLP payloads
  (~4KB per ResourceMetrics with 50 data points)

For a dashboard ingesting from a collector, 50K points/sec is more than
sufficient â€” a typical Prometheus scraping 100 targets at 15s intervals
produces ~700 points/sec.