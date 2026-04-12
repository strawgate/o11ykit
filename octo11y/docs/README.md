# Octo11y documentation

## Start here

- [`getting-started.md`](getting-started.md) — end-to-end setup for stash, aggregate, compare, monitor, and charts
- [`recipes.md`](recipes.md) — copy-paste workflow examples for Go, Rust, Python, bundle size, Docker, CI timing, and more
- [`product-surface-strategy.md`](product-surface-strategy.md) — roles and boundaries for the Octo11y site, Benchkit Demo, and Playground
- [`playground-setup.md`](playground-setup.md) — set up a separate repo for workflow and dashboard experiments
- [`adapters-architecture.md`](adapters-architecture.md) — charting library flexibility with data adapters
- [`reference/chart-adapter-ergonomics.md`](reference/chart-adapter-ergonomics.md) — concrete API ergonomics for Recharts, ECharts, and Visx
- [`migration-readiness.md`](migration-readiness.md) — what is supported today versus in-progress or blocked
- [`reference/actions.md`](reference/actions.md) — overview of all GitHub Actions
- [`reference/react-components.md`](reference/react-components.md) — React/Preact dashboard surfaces and chart primitives

## Architecture

- [`otlp-semantic-conventions.md`](otlp-semantic-conventions.md) — benchkit semantics on OTLP
- [`otlp-aggregation-architecture.md`](otlp-aggregation-architecture.md) — aggregation and storage architecture
- [`artifact-layout.md`](artifact-layout.md) — emitted files on the `bench-data` branch
- [`workflow-architecture.md`](workflow-architecture.md) — producer/aggregate workflow split
- [`../schema/README.md`](../schema/README.md) — schema reference for data files

## Roadmap and planning

- [`vision-and-roadmap.md`](vision-and-roadmap.md) — product direction and roadmap
- [`otlpkit-boundary-plan.md`](otlpkit-boundary-plan.md) — otlpkit/benchkit split boundary and compatibility plan
- [`internal/agent-handoff.md`](internal/agent-handoff.md) — current execution queue for agents

## Package and action references

- [`../packages/core`](../packages/core) — `@octo11y/core`: generic OTLP types, parsing, retry
- [`../packages/format/README.md`](../packages/format/README.md) — `@benchkit/format`: parsers, types, compare helpers
- [`../packages/chart/README.md`](../packages/chart/README.md) — `@benchkit/chart`: Preact dashboards and chart components
- [`../actions/stash/README.md`](../actions/stash/README.md)
- [`../actions/aggregate/README.md`](../actions/aggregate/README.md)
- [`../actions/compare/README.md`](../actions/compare/README.md)
- [`../actions/monitor/README.md`](../actions/monitor/README.md)
- [`../actions/emit-metric/README.md`](../actions/emit-metric/README.md)

## Other

- [`migration-beats-bench.md`](migration-beats-bench.md) — migration guide from `beats-bench`
- [`history/`](history/) — archived planning and review docs
- [`research/`](research/) — point-in-time audits and investigations
