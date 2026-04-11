# Architecture

This repository is organized as a layered monorepo:

1. `@otlpkit/*` (foundation)
2. `@octo11y/*` (GitHub-driven metrics product layer)
3. `@benchkit/*` (benchmark + monitor extensions)

## Dependency Direction

Allowed:

- `@octo11y/*` depends on `@otlpkit/*`
- `@benchkit/*` depends on `@octo11y/*`

Disallowed:

- `@otlpkit/*` depending on `@octo11y/*` or `@benchkit/*`
- `@octo11y/*` depending on `@benchkit/*`

## Package Scope Rules

- Generic OTLP parsing, query, view shaping, and chart adapters belong in `@otlpkit/*`.
- GitHub Actions/workflows and GitHub-derived metric logic belong in `@octo11y/*`.
- Benchmark-specific parsers, semantics, and monitor-centric extensions belong in `@benchkit/*`.

## Migration Status

Current state in this repo:

- Generic library packages have been renamed from `@metrickit/*` to `@otlpkit/*`.
- Demo/examples and build scripts now target the `@otlpkit/*` scope.
- GitHub Pages publishes a landing page at `/o11ykit/`, with solution paths at
  `/o11ykit/otlpkit/`, `/o11ykit/octo11y/`, and `/o11ykit/benchkit/`.
