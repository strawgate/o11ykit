# o11ykit

`o11ykit` is a monorepo for OTLP-driven tooling.

Top-level projects:

- `@otlpkit/*` (root `packages/*`): OTLP parsing/query/view/adapters for browser dashboards and app diagnostics.
- `octo11y` (`/octo11y`): GitHub Actions-driven metrics pipeline and UI packages.
- `benchkit` (`/octo11y`): benchmark-focused packages/actions layered on octo11y.

The root project currently hosts the `@otlpkit/*` JavaScript libraries:

- `@otlpkit/otlpjson`: parse, validate, flatten, and iterate OTLP JSON metrics, traces, and logs
- `@otlpkit/query`: filter, group, and bucket materialized telemetry records
- `@otlpkit/views`: build reusable frames such as time series, latest-value tables, histograms, trace waterfalls, and event timelines
- `@otlpkit/adapters`: project frames into library-native Chart.js, Recharts, ECharts, and uPlot shapes

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

- `/o11ykit/` landing page only
- `/o11ykit/otlpkit/` OtlpKit incident-story site
- `/o11ykit/octo11y/` Octo11y handoff page
- `/o11ykit/benchkit/` Benchkit handoff page

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
- `npm run octo11y:install`
- `npm run octo11y:check`
- `npm run check:all`

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
- `make check-all`
- `make check-release`
- `make clean`
- `make dev-demo`
- `make pages-build`
- `make octo11y-check`
