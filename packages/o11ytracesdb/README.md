# o11ytracesdb

> *SQLite for traces in the browser.*

Browser-native distributed traces database for OpenTelemetry span data.
Part of the **o11ykit** suite — browser-native databases for metrics, traces, and logs.

| Sibling | Signal | Key Technique |
|---------|--------|---------------|
| [o11ytsdb](../o11ytsdb/) | Metrics | XOR-delta (Gorilla), WASM-accelerated |
| [o11ylogsdb](../o11ylogsdb/) | Logs | Drain template extraction, FSST |
| **o11ytracesdb** | **Traces** | **Dictionary + nested set + bloom filter** |

**Status:** production-ready core. 10-section columnar codec, ingest, query,
trace assembly, structural queries — 66 passing tests, comprehensive benchmarks.

## Why

Today's observability UIs (Grafana, Kibana, Honeycomb) are **dumb terminals** —
every trace lookup round-trips to a server. Clicking an exemplar on a metric
chart triggers sequential network calls: fetch traces → fetch logs → re-render.
Hundreds of milliseconds per interaction, no offline support.

o11ytracesdb sits *after* your backend, inside the browser. It enables:
- **Zero-latency trace assembly** — assemble from local columnar storage
- **Instant structural queries** — O(1) ancestor/descendant via nested sets
- **Cross-signal correlation** — share time windows with o11ytsdb/o11ylogsdb in-memory
- **10–40× compression** — ~50 B/span vs 500–2000 B raw OTLP JSON

**Not Jaeger.** No Cassandra, no ES. **Not Tempo.** No Parquet files, no object storage.
Embedded, serverless, single-process — like SQLite, but for distributed traces.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              TraceStore (engine.ts)              │
│  append() → ChunkBuilder → sealed Chunk         │
│  flush()   iterChunks()   decodeChunk()         │
│  WeakMap decode cache (immutable chunks)        │
├─────────────────────────────────────────────────┤
│  StreamRegistry (stream.ts)                     │
│  FNV-1a intern of (resource, scope) → StreamId  │
│  Resource/Scope stored once per stream (0 B/span)│
├─────────────────────────────────────────────────┤
│  ChunkBuilder (chunk.ts)                        │
│  Accumulates spans → flush → Chunk              │
│  Zone maps: time range, hasError, spanNames     │
│  BF8 bloom filter on trace IDs                  │
│  Nested set computation (per-trace DFS)         │
├─────────────────────────────────────────────────┤
│  ColumnarTracePolicy (codec-columnar.ts)        │
│  10-section columnar payload:                   │
│  [timestamps|durations|IDs|names|kind|status|   │
│   attributes|events|links|nested-sets]          │
│  Partial decode: decodeIdsOnly() skips 8/10 sec │
├─────────────────────────────────────────────────┤
│  Query Engine (query.ts)                        │
│  queryTraces() — chunk pruning → decode → match │
│  buildSpanTree() — merged-interval self-time    │
│  criticalPath() — greedy latest-end traversal   │
│  isAncestorOf/isDescendantOf — O(1) nested set  │
└─────────────────────────────────────────────────┘
```

## Per-Column Compression

| Column | Encoding | Est. B/span |
|--------|----------|-------------|
| trace_id | Raw 16 bytes | 16.0 |
| span_id | Raw 8 bytes | 8.0 |
| parent_span_id | Raw 8 bytes + null bitmap | ~7.5 |
| start_time_unix_nano | Delta-of-delta + zigzag | ~0.3 |
| end_time_unix_nano | Delta-of-delta + zigzag | ~0.3 |
| duration_ns | Zigzag varint | ~0.5 |
| name (operation) | Per-chunk dictionary + u16 | ~0.3 |
| kind | u8 | 1.0 |
| status.code + message | u8 + dictionary | ~0.1 |
| Attributes | Dual dictionaries + tagged | ~5–15 |
| Events | Delta timestamps from span start | ~0.5 |
| Links | Raw IDs + inline attrs | ~1.0 |
| BF8 bloom filter | ~10 bits/trace | ~0.06 |
| Nested set (left, right, parent) | Delta-encoded i32 | ~0.3 |
| **Total (typical, 5 attrs)** | | **~50 B/span** |

## Performance

Benchmarks on Apple Silicon (M-series), no WASM acceleration:

| Operation | Throughput | Latency (mean) |
|-----------|-----------|----------------|
| Encode 1K spans | 363 ops/s | 2.8 ms |
| Decode 1K spans | 511 ops/s | 2.0 ms |
| Ingest 1K spans | 312 ops/s | 3.2 ms |
| Query by trace_id | 224 ops/s | 4.5 ms |
| Tree assembly (200 spans) | 4,539 ops/s | 0.22 ms |
| Critical path (50 spans) | 18,783 ops/s | 0.05 ms |

## Key Design Decisions

1. **Spans as rows** — not traces-per-row (like Tempo). Enables efficient
   columnar scans and chunk-level pruning on span attributes.

2. **Chunk by (resource, scope)** — resource/scope hoisted to stream
   registry = 0 bytes/span for service name, SDK version, etc.

3. **BF8 bloom filter on trace_id** — per-chunk, 10 bits/element, 7 hash
   functions. Prunes 95%+ chunks for `assembleTrace()` lookups.

4. **Partial decode** — sections are length-prefixed (u32 LE). The query
   engine can decode only IDs (section 2) without parsing timestamps,
   attributes, events, or links.

5. **Event delta timestamps** — events stored as `timeUnixNano - spanStart`.
   Reduces varint from ~10 bytes to ~2-3 bytes per event.

6. **Dictionary encoding** — 4 separate frequency-sorted dictionaries:
   span names, attribute keys, short attribute values, status messages.
   O(1) Map-based encode lookups.

7. **Delta-of-delta** — separate DoD streams for start and end times.
   Adjacent spans in the same chunk often have very close timestamps.

8. **Nested set encoding** — per-trace DFS numbering assigns (left, right,
   parent) integers to each span at flush() time. Enables O(1) ancestor/
   descendant/sibling checks via `isAncestorOf()`, `isDescendantOf()`,
   `isSiblingOf()` without tree traversal.

## API

```typescript
import {
  TraceStore,
  queryTraces,
  assembleTrace,
  buildSpanTree,
  criticalPath,
  isAncestorOf,
  isDescendantOf,
  isSiblingOf,
} from "o11ytracesdb";

// Ingest
const store = new TraceStore({ chunkSize: 1024 });
store.append(resource, scope, spans);
store.flush();

// Query
const result = queryTraces(store, {
  startTimeNano: 1700000000000000000n,
  endTimeNano:   1700000001000000000n,
  serviceName: "api-gateway",
  spanName: "HTTP GET /users",
  statusCode: 2, // ERROR
  limit: 50,
});

// Trace assembly + tree
const trace = assembleTrace(store, traceId);
const roots = buildSpanTree(trace.spans);
const path = criticalPath(roots);

// Structural queries (O(1) via nested set encoding)
const parent = trace.spans[0];
const child = trace.spans[1];
isAncestorOf(parent, child);    // true — no tree walk needed
isDescendantOf(child, parent);  // true
isSiblingOf(child, child2);     // true if same parent
```

## Roadmap

| Feature | Status |
|---------|--------|
| Columnar codec (10 sections) | ✅ Done |
| Dictionary encoding | ✅ Done |
| Delta-of-delta timestamps | ✅ Done |
| BF8 bloom filter | ✅ Done |
| Partial decode (IDs only) | ✅ Done |
| Event delta timestamps | ✅ Done |
| Chunk zone maps (time, error, names) | ✅ Done |
| Two-phase trace assembly | ✅ Done |
| Merged-interval self-time | ✅ Done |
| Critical path computation | ✅ Done |
| Nested set encoding | ✅ Done |
| Dedicated attribute columns | 🔜 Planned |
| WASM-accelerated codec | 🔜 Planned |
| ZSTD compression layer | 🔜 Planned |
| IndexedDB persistence | 🔜 Planned |
| TTL / eviction | 🔜 Planned |
| RED metrics derivation → o11ytsdb | 🔜 Planned |
