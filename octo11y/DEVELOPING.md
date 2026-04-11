# Developing benchkit

This guide is for contributors working on benchkit internals.

## Prerequisites

- Node.js 24+
- npm

## Documentation map

Use the docs that match the audience you are working for:

- [`README.md`](README.md) — user-facing product overview
- [`docs/README.md`](docs/README.md) — documentation hub
- [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md) — product direction and source of truth for roadmap/shipped status
- [`RELEASING.md`](RELEASING.md) — release process
- [`CODE_STYLE.md`](CODE_STYLE.md) — reviewer preferences not enforced by lint
- [`AGENTS.md`](AGENTS.md) — routing and rules for AI agents

## Repository layout

- `packages/core/`: generic OTLP types, parsing, and retry helpers (`@octo11y/core`)
- `packages/format/`: benchmark types, parsers, OTLP helpers, compare helpers (re-exports generic types from `@octo11y/core`)
- `packages/chart/`: Preact dashboard components, chart primitives, fetch helpers
- `packages/dashboard/`: private dogfood app deployed to [GitHub Pages](https://strawgate.github.io/octo11y/) — not a template (build from `@benchkit/chart` instead)
- `actions/stash/`: GitHub Action to parse and store run data
- `actions/aggregate/`: GitHub Action to build indexes and views
- `actions/compare/`: GitHub Action to compare results against a baseline
- `actions/monitor/`: GitHub Action for collector-backed telemetry capture
- `actions/emit-metric/`: GitHub Action for emitting one-off OTLP metrics
- `actions/repo-stats/`: GitHub Action for collecting GitHub repository statistics
- `schema/`: JSON schemas for generated data files
- `docs/`: user, architecture, historical, internal, and research docs

## Install dependencies

```bash
npm ci
```

## Build

Build everything:

```bash
npm run build
```

Build a specific workspace:

```bash
npm run build --workspace=packages/core
npm run build --workspace=packages/format
npm run build --workspace=packages/chart
npm run build --workspace=packages/dashboard
npm run build --workspace=actions/stash
npm run build --workspace=actions/aggregate
npm run build --workspace=actions/compare
npm run build --workspace=actions/monitor
npm run build --workspace=actions/emit-metric
npm run build --workspace=actions/repo-stats
```

## Test

Run all tests:

```bash
npm run test
```

Run a single workspace test suite:

```bash
npm run test --workspace=packages/format
npm run test --workspace=packages/chart
```

## Lint and type checks

```bash
npm run lint
```

This runs ESLint (flat config in `eslint.config.mjs`) and `tsc --noEmit` across all workspaces.

## Working on GitHub actions

Action bundles in `actions/*/dist/` are **not** committed to the repo.
CI automatically builds and pushes them to the `main-dist` branch on every push to `main`.
PR builds are pushed to `pr/{number}-dist` branches.

When developing action changes locally, run `npm run build` to generate dist/ for local testing.
Do not commit `dist/` files — they are in `.gitignore`.

## Adding features

1. Decide the target surface first: format package, chart package, or action.
2. Add or update tests in the same workspace.
3. Keep public API changes documented in the package or action README you changed.
4. If data contracts change, update `schema/` and the relevant docs in the same PR.
5. If a user-facing workflow changes, update [`docs/getting-started.md`](docs/getting-started.md) or the appropriate reference doc.

## Contribution checklist

1. `npm run build`
2. `npm run test`
3. `npm run lint`
4. Update docs for user-visible behavior changes
