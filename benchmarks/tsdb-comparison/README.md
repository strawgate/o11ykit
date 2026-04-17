# TSDB Benchmark: Prometheus vs VictoriaMetrics vs Mimir

Compares **storage efficiency** and **query performance** across three major
time-series databases using identical synthetic OTLP metrics.

## What It Measures

1. **Storage efficiency** — How much disk space each TSDB uses to store the
   same dataset. Measured via `du` on Docker volumes + internal TSDB metrics.

2. **Query performance** — Latency (p50/p95/p99) of identical PromQL queries
   against all three. Includes simple selects, rate calculations, aggregations,
   histogram quantiles, and range queries.

## Metric Types

The synthetic workload generates all 5 OTLP metric types:

| Metric | Type | Description |
|--------|------|-------------|
| `bench_cpu_usage_percent` | Gauge | Synthetic CPU utilization |
| `bench_http_requests_total` | Sum (monotonic) | HTTP request counter |
| `bench_request_duration_seconds` | Histogram | Request duration distribution |
| `bench_db_query_duration_seconds` | ExponentialHistogram | DB query duration |
| `bench_gc_pause_seconds` | Summary | GC pause duration quantiles |

## Quick Start

```bash
# 1. Start the TSDBs
cd benchmarks/tsdb-comparison
docker compose up -d

# 2. Wait for healthy (all three should be healthy)
docker compose ps

# 3. Install dependencies
npm install

# 4. Run the full benchmark
npx tsx src/index.ts

# 5. View results
cat results/benchmark-report.md
```

## CLI Options

```
npx tsx src/index.ts [options]

--phase <name>     Run a single phase: generate, ingest, storage, query, report
--series <n>       Number of series per metric type (default: 100)
--samples <n>      Samples per series (default: 360)
--iterations <n>   Query benchmark iterations (default: 50)
--batch-size <n>   OTLP requests batch size (default: 500)
--help             Show help
```

## Architecture

```
Synthetic OTLP Generator (TypeScript)
         │
         ├── POST /api/v1/otlp/v1/metrics ──→ Prometheus  :9090
         ├── POST /opentelemetry/v1/metrics ─→ VictoriaMetrics :8428
         └── POST /otlp/v1/metrics ──────────→ Mimir :9009
                                                  │
                                    PromQL queries (identical)
                                                  │
                                         Benchmark results
```

## TSDB Configuration

All three run in Docker with:
- Local filesystem storage (mounted volumes for measurement)
- 24h retention
- Native OTLP ingestion (no OpenTelemetry Collector needed)
- Native/exponential histogram support enabled

| TSDB | Image | OTLP Path | PromQL Path |
|------|-------|-----------|-------------|
| Prometheus | `prom/prometheus:latest` | `/api/v1/otlp/v1/metrics` | `/api/v1/query` |
| VictoriaMetrics | `victoriametrics/victoria-metrics:latest` | `/opentelemetry/v1/metrics` | `/api/v1/query` |
| Mimir | `grafana/mimir:latest` | `/otlp/v1/metrics` | `/prometheus/api/v1/query` |

## Output

Results are written to `results/`:
- `benchmark-report.md` — Human-readable Markdown comparison
- `benchmark-report.json` — Machine-readable JSON for further analysis
