# o11ytracesdb — Research & Design Decisions

## Sources

- **Tempo vParquet4**: Grafana Tempo's Apache Parquet-based storage format
  - Nested set encoding for structural queries (ancestor/descendant in O(1))
  - Dedicated attribute columns for top-N keys (http.status_code, service.name)
  - Bloom filters per row group for trace ID lookups
  - Source: https://grafana.com/docs/tempo/latest/operations/backend/

- **ClickHouse traces schema**: ClickHouse's approach to trace storage
  - Materialized columns for frequently-queried attributes
  - Bloom filter indexes on trace_id columns
  - ZSTD compression for cold data, LZ4 for hot
  - MergeTree engine with time-based partitioning
  - Source: https://clickhouse.com/docs/en/engines/table-engines/mergetree-family

- **Jaeger V2 (OTEL-native)**: Modern trace backend
  - Adaptive sampling based on span attributes
  - Service graph derivation from span relationships

## Key Patterns Adopted

### 1. BF8 Bloom Filter (from ClickHouse/Tempo)
Per-chunk bloom filter using double hashing (FNV-1a + Murmur).
10 bits/element, 7 hash functions → <0.1% FPR.
Prunes 95%+ of chunks for trace_id lookups.

### 2. Nested Set Encoding (from Tempo vParquet4)
DFS-assigned (left, right, parent) integers per span enable O(1) structural queries:
- `isAncestorOf(a, b)`: a.left < b.left && b.right < a.right
- `isDescendantOf(a, b)`: isAncestorOf(b, a)
- `isSiblingOf(a, b)`: a.parent == b.parent

Computed at flush() time (zero cost at ingest). Delta-encoded in Section 9
for minimal storage overhead (~0.3 B/span).

### 3. Partial Decode (from Parquet column projection)
Length-prefixed sections allow skipping irrelevant columns.
`decodeIdsOnly()` reads only Section 2 (IDs) — skips timestamps, attributes,
events, links, nested sets. Used for trace assembly's first pass.

### 4. Event Delta Timestamps (from Tempo)
Span events stored as `timeUnixNano - spanStartTime`. Reduces varint encoding
from ~10 bytes (absolute nanoseconds) to ~2-3 bytes (relative offset).

### 5. Chunk-Level Zone Maps (from Parquet/ClickHouse)
Each chunk header stores min/max time range, hasError flag, and span name set.
Query engine prunes entire chunks without decode when predicates don't overlap.

### 6. Dictionary Encoding (from ClickHouse LowCardinality)
Four separate frequency-sorted dictionaries per chunk:
- Span names (very low cardinality, ~10-50 unique per service)
- Attribute keys (shared across all spans in chunk)
- Attribute string values (low-cardinality subset)
- Status messages (very sparse)

Map-based O(1) encode lookups. Dictionary indices stored as u16 (supports 65K unique values per chunk).

### 7. WeakMap Decode Cache (original)
Since Chunk objects are immutable and reference-stable (stored in StreamRegistry),
WeakMap<Chunk, SpanRecord[]> provides automatic GC when chunks are evicted.
Eliminates repeated decode cost for hot queries (3.2ms → 1.6ms per trace lookup).

## Decisions NOT Adopted (and why)

| Pattern | Why Not |
|---------|---------|
| Parquet file format | Too heavy for browser; requires full columnar engine |
| ZSTD compression | Requires WASM; planned for future phase |
| Dedicated attribute columns | Planned (promotes top-N keys to typed columns) |
| Service graph derivation | Planned for cross-signal correlation phase |
| Adaptive sampling | Out of scope (storage layer, not collection) |
| Full-text search on attributes | Overkill for trace attributes; dictionary + bloom sufficient |

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Storage efficiency | ~50 B/span | 10-40× vs raw OTLP JSON |
| Encode throughput | 363 ops/s (1K spans) | 2.8ms per 1K spans |
| Decode throughput | 511 ops/s (1K spans) | 2.0ms per 1K spans |
| Query by trace_id | 224 ops/s | With bloom filter pruning |
| Tree assembly | 4,539 ops/s (200 spans) | Adjacency list → tree |
| Critical path | 18,783 ops/s (50 spans) | Greedy latest-end DFS |
| Bloom FPR | <0.1% | 10 bits/element, 7 hashes |
| Chunk prune rate | ~95%+ | For trace_id lookups |

## Architecture Inspirations

The design follows a "columnar chunk store" pattern shared by:
- **Apache Parquet** (row groups + column chunks + page encoding)
- **ClickHouse MergeTree** (parts + columns + granules)
- **Tempo vParquet4** (trace-specific Parquet schema)
- **o11ytsdb** (sibling: XOR-delta chunks for metrics)
- **o11ylogsdb** (sibling: Drain + FSST chunks for logs)

Key difference: our chunks live in browser memory (ArrayBuffer), not on disk.
This means no page cache, no mmap — but also no I/O latency. The decode cache
(WeakMap) substitutes for the OS page cache.
