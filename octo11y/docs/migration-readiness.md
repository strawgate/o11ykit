# Migration readiness and example coverage

This matrix shows what benchkit supports directly, what exists only in the
[benchkit-demo](https://github.com/strawgate/octo11y-demo) repository, and what
is still missing or blocked.

## Example and workflow coverage

| Scenario | In benchkit | In benchkit-demo | Missing / blocked |
|---|---|---|---|
| **Go code benchmark** (`go test -bench`) | `getting-started.md` workflow, stash/aggregate/compare actions | Full working repo with CI | — |
| **Rust code benchmark** | Format parser (`parseRustBench`) | — | No starter workflow or example repo |
| **Hyperfine benchmark** | Format parser (`parseHyperfine`) | — | No starter workflow or example repo |
| **pytest-benchmark** | Format parser (`parsePytestBenchmark`) | — | No starter workflow or example repo |
| **Workflow benchmark** (HTTP, JSON stats, etc.) | `actions/emit-metric` + `actions/monitor` | Collector helpers, dashboard, workflow examples | No in-repo starter or cookbook |
| **Hybrid run** (outcome + telemetry) | `actions/monitor` OTLP endpoint + stash | Combined demo workflow | No in-repo walkthrough |
| **OTLP producer example** | `actions/emit-metric` docs | Workflow with custom OTLP producer | No standalone example |
| **Dashboard deployment** | `packages/dashboard` (dogfood), chart README | Custom dashboard with Vite | — |

## Migration status

| Migration | Status | Notes |
|---|---|---|
| **beats-bench → benchkit** | Blocked upstream | Requires `beats-bench summarize --output-format benchkit` flag (not yet implemented in beats-bench). See [`migration-beats-bench.md`](migration-beats-bench.md). |
| **benchmark-action → benchkit** | Ready | `parseBenchmarkAction` parser exists. Users can stash output directly. |
| **Custom OTLP pipeline → benchkit** | Ready | Point any OTLP exporter at `actions/monitor`'s collector endpoint. |

## Where to go next

- [Getting started](getting-started.md) — end-to-end setup for the supported path
- [beats-bench migration guide](migration-beats-bench.md) — detailed field mapping (blocked upstream)
- [Chart component guide](reference/react-components.md) — dashboard surfaces
