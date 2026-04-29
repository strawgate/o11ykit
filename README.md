# o11ykit

> *SQLite for observability in the browser.*

`o11ykit` is a monorepo for browser-native observability tooling — OTLP parsing,
columnar compression databases, and cross-signal correlation entirely client-side.

Top-level projects:

- `@otlpkit/*` (root `packages/*`): OTLP parsing/query/view/adapters for browser dashboards and app diagnostics.
- `o11ytsdb` (root `packages/o11ytsdb`): browser-native time-series database for OpenTelemetry data with WASM-accelerated codecs.
- `o11ylogsdb` (root `packages/o11ylogsdb`): browser-native logs database for OpenTelemetry data with Drain template extraction and FSST compression.
- `o11ytracesdb` (root `packages/o11ytracesdb`): browser-native traces database for OpenTelemetry span data with 10-section columnar codec, bloom filter chunk pruning, and nested set structural queries.
- `octo11y` (`/octo11y`): GitHub Actions-driven metrics pipeline and UI packages.
- `benchkit` (`/octo11y`): benchmark-focused packages/actions layered on octo11y.

The root project currently hosts the `@otlpkit/*` JavaScript libraries:

- `@otlpkit/otlpjson`: parse, validate, flatten, and iterate OTLP JSON metrics, traces, and logs
- `@otlpkit/query`: filter, group, and bucket materialized telemetry records
- `@otlpkit/views`: build reusable frames such as time series, latest-value tables, histograms, trace waterfalls, and event timelines
- `@otlpkit/adapters`: project frames into library-native Chart.js, Recharts, ECharts, and uPlot shapes

And the `o11ytsdb` time-series database:

- `o11ytsdb`: XOR-delta (Gorilla) codec with TypeScript, Zig→WASM, and Rust→WASM implementations; chunked and columnar storage backends; baseline query engine. See [`packages/o11ytsdb/README.md`](./packages/o11ytsdb/README.md) for benchmarks and status.

And the `o11ylogsdb` logs database:

- `o11ylogsdb`: Drain template extraction + FSST + columnar codec; streaming query executor with chunk-level pruning. See [`packages/o11ylogsdb/README.md`](./packages/o11ylogsdb/README.md) for milestones and status.

And the `o11ytracesdb` traces database:

- `o11ytracesdb`: 10-section columnar codec, BF8 bloom filter chunk pruning, nested set structural queries, delta-of-delta timestamps, dictionary encoding — ~50 B/span (10–40× vs raw OTLP JSON). See [`packages/o11ytracesdb/README.md`](./packages/o11ytracesdb/README.md) for architecture and benchmarks.

Together, these three databases form **browser-native observability storage** — *SQLite for observability in the browser* — enabling zero-latency cross-signal correlation without server round-trips.

The root project currently hosts this GitHub Action:

- `actions/parse-results`: parse benchmark output from workflow logs (`mode=auto`) or files (`mode=file`) and stash normalized OTLP JSON by default

Monorepo layering:

- `@otlpkit/*`: generic OTLP primitives and adapters
- `@octo11y/*`: GitHub-driven metrics actions and aggregation
- `@benchkit/*`: benchmark-focused extension layer on top of octo11y

Dependency rule: `benchkit -> octo11y -> otlpkit`.

`octo11y` and `benchkit` source now lives under [`octo11y/`](./octo11y), including:

- actions: `monitor`, `emit-metric`, `stash`, `parse-results`, `aggregate`, `compare`, `repo-stats`
- packages: `@octo11y/core`, `@benchkit/format`, `@benchkit/adapters`, `@benchkit/chart`, `@benchkit/dashboard`

## Pages Site

GitHub Pages publishes a small portal:

- `/o11ykit/` platform overview for OtlpKit, o11ytsdb, Octo11y, and Benchkit
- `/o11ykit/tsdb-engine/` TSDB engine site and interactive codec demos
- `/o11ykit/otlpkit/` OtlpKit incident-story site
- `/o11ykit/charts/` chart adapter gallery plan for engine-backed Tremor, Recharts, Chart.js, ECharts, uPlot, Nivo, Visx, Observable Plot, and Plotly demos
- `/o11ykit/octo11y/` Octo11y guide and pipeline walkthrough
- `/o11ykit/benchkit/` Benchkit demo and regression-automation handoff
- `/o11ykit/logsdb-engine/` LogsDB engine site and interactive log storage/query demo

## Development

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:e2e`
- `npm run build`
- `npm run check:release`
- `npm run dev:chartjs`
- `npm run dev:demo`
- `npm run dev:echarts`
- `npm run dev:recharts`
- `npm run dev:uplot`
- `npm run dev:types`
- `npm run clean`
- `npm run clean:all`
- `npm run octo11y:install`
- `npm run octo11y:check`
- `npm run check:all`

`check:release` validates publish artifacts with `npm pack --dry-run`, `publint`, and `attw`.

## Release + Publishing

See [`RELEASING.md`](./RELEASING.md) for trusted publishing setup, bootstrap steps for new package names, and the recommended security-key flow that avoids one OTP per command.

## Make Targets

If you prefer `make`, there is a top-level `Makefile` with common targets:

- `make install`
- `make lint`
- `make format`
- `make typecheck`
- `make test`
- `make test-e2e`
- `make build`
- `make check`
- `make check-all`
- `make check-release`
- `make clean`
- `make dev-demo`
- `make pages-build`
- `make octo11y-check`
