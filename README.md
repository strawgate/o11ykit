# obskit

`obskit` is a monorepo for OTLP-driven tooling.

Current packages in this repo are the `@otlpkit/*` JavaScript libraries:

- `@otlpkit/otlpjson`: parse, validate, flatten, and iterate OTLP JSON metrics, traces, and logs
- `@otlpkit/query`: filter, group, and bucket materialized telemetry records
- `@otlpkit/views`: build reusable frames such as time series, latest-value tables, histograms, trace waterfalls, and event timelines
- `@otlpkit/adapters`: project frames into library-native Chart.js, Recharts, ECharts, and uPlot shapes

Planned monorepo layering:

- `@otlpkit/*`: generic OTLP primitives and adapters
- `@octo11y/*`: GitHub-driven metrics actions and aggregation
- `@benchkit/*`: benchmark-focused extension layer on top of octo11y

Dependency rule: `benchkit -> octo11y -> otlpkit`.

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

`check:release` validates publish artifacts with `npm pack --dry-run`, `publint`, and `attw`.

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
- `make check-release`
- `make clean`
- `make dev-demo`
