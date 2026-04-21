# Architecture

This repository is organized as a layered monorepo:

1. `@otlpkit/*` (foundation)
2. `o11ytsdb` (browser-native time-series database)
3. `@octo11y/*` (GitHub-driven metrics product layer)
4. `@benchkit/*` (benchmark + monitor extensions)

## Dependency Direction

Allowed:

- `o11ytsdb` depends on `@otlpkit/*`
- `@octo11y/*` depends on `@otlpkit/*`
- `@benchkit/*` depends on `@octo11y/*`

Disallowed:

- `@otlpkit/*` depending on `@octo11y/*`, `@benchkit/*`, or `o11ytsdb`
- `@octo11y/*` depending on `@benchkit/*`

## Package Scope Rules

- Generic OTLP parsing, query, view shaping, and chart adapters belong in `@otlpkit/*`.
- Time-series storage, compression codecs, and in-browser query execution belong in `o11ytsdb`.
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

## Migration Status

Current state in this repo:

- Generic library packages have been renamed from `@metrickit/*` to `@otlpkit/*`.
- Demo/examples and build scripts now target the `@otlpkit/*` scope.
- GitHub Pages publishes a landing page at `/o11ykit/`, with solution paths at
  `/o11ykit/otlpkit/`, `/o11ykit/tsdb-engine/`, `/o11ykit/octo11y/`, and `/o11ykit/benchkit/`.
