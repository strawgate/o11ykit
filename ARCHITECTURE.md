# Architecture

> **o11ykit** — *SQLite for observability in the browser.*

This repository is organized as a layered monorepo providing browser-native
databases for all three OpenTelemetry signals:

1. `@otlpkit/*` (foundation — OTLP parsing/query/view/adapters)
2. **`o11ytsdb`** (browser-native time-series database — metrics)
3. **`o11ylogsdb`** (browser-native logs database — logs)
4. **`o11ytracesdb`** (browser-native traces database — traces)
5. `@octo11y/*` (GitHub-driven metrics product layer)
6. `@benchkit/*` (benchmark + monitor extensions)

The three `o11y*db` packages form **browser-native observability storage** —
enabling zero-latency cross-signal correlation entirely client-side.

## Dependency Direction

Allowed:

- `o11ytsdb` depends on `@otlpkit/*`, `stardb`
- `o11ylogsdb` depends on `@otlpkit/*`, `stardb`, `o11y-codec-rt`
- `o11ytracesdb` depends on `stardb`
- `@octo11y/*` depends on `@otlpkit/*`
- `@benchkit/*` depends on `@octo11y/*`

Disallowed:

- `@otlpkit/*` depending on `@octo11y/*`, `@benchkit/*`, or `o11y*db`
- `@octo11y/*` depending on `@benchkit/*`
- Cross-dependencies between `o11y*db` packages (they correlate via shared types, not imports)

## Package Scope Rules

- Generic OTLP parsing, query, view shaping, and chart adapters belong in `@otlpkit/*`.
- Time-series storage, XOR-delta/ALP compression, and metric query execution belong in `o11ytsdb`.
- Log storage, Drain template extraction, FSST compression, and log query execution belong in `o11ylogsdb`.
- Trace storage, columnar span encoding, bloom filters, and trace query execution belong in `o11ytracesdb`.
- Shared codec primitives (bit I/O, varint, zigzag, interner) belong in `o11y-codec-rt`.
- GitHub Actions/workflows and GitHub-derived metric logic belong in `@octo11y/*`.
- Benchmark-specific parsers, semantics, and monitor-centric extensions belong in `@benchkit/*`.

## o11ytsdb Compression Codecs

`o11ytsdb` compresses f64 time-series values using three codecs, selected
automatically per chunk:

| Codec | Mechanism | Best For | Typical B/pt |
|-------|-----------|----------|--------------|
| XOR-Delta | Gorilla bit-packing (VLDB 2015) | high-entropy floats | 2–7 |
| ALP | Decimal exponent + FoR bit-pack (SIGMOD 2024) | gauges, rates | 0.02–1.4 |
| Delta-ALP | Differencing + ALP | monotonic counters | 0.5–1.0 |

Selection is transparent: ALP functions try delta-ALP on counter-shaped
data (no resets, increasing, integer-valued), fall back to plain ALP, and
keep whichever is smaller. The decoder dispatches on the first byte.

See [`packages/o11ytsdb/docs/codecs.md`](packages/o11ytsdb/docs/codecs.md)
for wire formats, detection criteria, and detailed benchmarks.

## o11ytracesdb Architecture

`o11ytracesdb` stores distributed trace spans in a 10-section columnar codec:

| Section | Content | Encoding |
|---------|---------|----------|
| 0 | Timestamps | Delta-of-delta + zigzag varint |
| 1 | Durations | Zigzag varint |
| 2 | IDs (trace, span, parent) | Raw bytes + null bitmap |
| 3 | Span names | Per-chunk dictionary + u16 indices |
| 4 | Kind | u8 per span |
| 5 | Status | u8 + message dictionary |
| 6 | Attributes | Dual dictionaries + tagged values |
| 7 | Events | Delta timestamps + sub-chunks |
| 8 | Links | Raw IDs + inline attributes |
| 9 | Nested sets | Delta-encoded i32 (left, right, parent) |

Key features:
- **BF8 bloom filter** per chunk for trace_id lookup acceleration
- **Partial decode** — skip 8/10 sections for ID-only queries
- **Nested set encoding** — O(1) ancestor/descendant checks
- **WeakMap decode cache** — automatic GC when chunks are evicted
- **Memory budget** — configurable maxPayloadBytes / maxChunks / TTL eviction
- **Cross-signal correlation** — RED metrics derivation, service graph, time window sharing

See [`packages/o11ytracesdb/README.md`](packages/o11ytracesdb/README.md)
for API docs, benchmarks, and full architecture diagram.

## Cross-Signal Correlation

The three databases can be used together for zero-latency correlation:

```
                    ┌─────────────┐
                    │  OTLP Input │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌───▼────┐ ┌────▼─────┐
        │ o11ytsdb  │ │o11y    │ │ o11y     │
        │ (metrics) │ │logsdb  │ │tracesdb  │
        └─────┬─────┘ └───┬────┘ └────┬─────┘
              │            │            │
              └────────────┼────────────┘
                           │
                  ┌────────▼────────┐
                  │  Correlation    │
                  │  Layer          │
                  │                 │
                  │ • Time windows  │
                  │ • Trace IDs     │
                  │ • RED metrics   │
                  │ • Service graph │
                  └─────────────────┘
```

Correlation is *in-memory* — no network calls. Brush-select a metric spike →
pass time window to traces/logs → render correlated data in <1ms.

## Migration Status

Current state in this repo:

- Generic library packages have been renamed from `@metrickit/*` to `@otlpkit/*`.
- Demo/examples and build scripts now target the `@otlpkit/*` scope.
- GitHub Pages publishes a landing page at `/o11ykit/`, with solution paths at
  `/o11ykit/otlpkit/`, `/o11ykit/tsdb-engine/`, `/o11ykit/octo11y/`, and `/o11ykit/benchkit/`.
