# Benchkit Monitor

System and custom metrics collection via the OpenTelemetry Collector
(`otelcol-contrib`). The action downloads a collector binary, starts it as a
background process, exposes OTLP receivers for your benchmark code, and then
stops and flushes telemetry automatically in the action post step.

Use a published dist ref (`@main-dist` or a version tag). Do not use `@main`
for JS actions, because `@main` does not include compiled action bundles.

## What it does

- collects host metrics through the collector's `hostmetrics` receiver
- enables OTLP gRPC (`4317`) and HTTP (`4318`) receivers by default so your
  benchmark code can emit custom metrics to the same collector
- waits for the OTLP HTTP receiver to answer before returning so the next step
  can emit metrics immediately
- installs a `benchkit-emit` CLI for one-off workflow metrics without a full
  OTLP SDK
- creates a shared metrics directory and exports
  `BENCHKIT_METRICS_DIR`, `BENCHKIT_RUN_ID`, and `BENCHKIT_EMIT_ENDPOINT`
- writes a raw OTLP JSONL sidecar (gzipped) to the data branch at
  `data/runs/{run-id}/telemetry.otlp.jsonl.gz`
- writes a consolidated OTLP JSON document to
  `${BENCHKIT_METRICS_DIR}/monitor.otlp.json` in the post step
- filters process metrics to runner-descendant processes before pushing, so the
  stored telemetry stays focused on the benchmark job instead of the whole host

## Usage

```yaml
jobs:
  bench:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Start monitor
        id: monitor
        uses: strawgate/octo11y/actions/monitor@main-dist
        with:
          profile: ci
          scrape-interval: 5s

      - name: Run benchmarks
        env:
          OTEL_EXPORTER_OTLP_ENDPOINT: ${{ steps.monitor.outputs.otlp-http-endpoint }}
        run: |
          go test -bench=. -benchmem -count=3 ./... | tee bench.txt

      - name: Stash benchmark results
        uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt
          format: go
```

There is no explicit stop step. The action post step runs automatically when the
job finishes, shuts down the collector, flushes telemetry, and pushes the raw
OTLP sidecar to the data branch.

## Emitting a one-off custom metric

If your workflow only needs to record a custom score or count, use the
`benchkit-emit` CLI installed by monitor:

```yaml
- name: Emit score metric
  run: |
    benchkit-emit --name test_score --value 74 --unit points \
      --scenario search-relevance --series baseline --direction up
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `collector-version` | no | `0.149.0` | OTel Collector Contrib version to download. See [otelcol-contrib releases](https://github.com/open-telemetry/opentelemetry-collector-releases/releases) for available versions. |
| `profile` | no | `default` | Preset tuning. Use `ci` to reduce process-scraper noise in hosted CI logs by enabling collector-side process error muting. |
| `scrape-interval` | no | `5s` | Host-metrics scrape interval. |
| `metric-sets` | no | `` | Comma-separated host metric scrapers to enable. If empty, profile defaults apply (`default`: `cpu,memory,load,process`; `ci`: `cpu,memory,load,process`). |
| `otlp-grpc-port` | no | `4317` | OTLP gRPC receiver port. Set to `0` to disable. |
| `otlp-http-port` | no | `4318` | OTLP HTTP receiver port. Set to `0` to disable. |
| `data-branch` | no | `bench-data` | Branch where the telemetry sidecar is pushed. |
| `run-id` | no | `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` | Run identifier used for the stored telemetry file. |
| `github-token` | no | `${{ github.token }}` | Token used to push telemetry to the data branch. |

## Outputs

| Output | Description |
|--------|-------------|
| `otlp-grpc-endpoint` | OTLP gRPC endpoint, e.g. `grpc://localhost:4317` |
| `otlp-http-endpoint` | OTLP HTTP endpoint, e.g. `http://localhost:4318` |
| `metrics-dir` | Shared metrics directory, e.g. `${RUNNER_TEMP}/benchkit-metrics` |

## Stored output

The collector exports line-delimited OTLP JSON to a temporary file during the
job. In the post step, benchkit:

1. stops the collector gracefully
2. filters process resources to runner-descendant processes
3. compresses the telemetry sidecar with gzip
4. copies the telemetry sidecar to `data/runs/{run-id}/telemetry.otlp.jsonl.gz`
5. commits and pushes that file to the data branch

Telemetry sidecars are immutable by `run-id`. If
`data/runs/{run-id}/telemetry.otlp.jsonl.gz` already exists, the post step
fails instead of overwriting it.

Benchkit also stamps resource attributes such as `benchkit.run_id`,
`benchkit.kind=hybrid`, `benchkit.source_format=otlp`, and, when available,
`benchkit.ref` and `benchkit.commit`.

In addition, monitor writes a consolidated OTLP JSON file to
`${BENCHKIT_METRICS_DIR}/monitor.otlp.json` so `actions/stash` can merge monitor
and custom CLI metrics without JSONL conversion glue.

## How it works

1. **Start**: download `otelcol-contrib` from the GitHub release, generate a
   collector config from action inputs, and launch it as a detached process
2. **Collect**: scrape host metrics and accept user OTLP metrics through the
   enabled OTLP receivers
3. **Post step**: stop the collector automatically, let it flush pending data,
   filter process metrics, and push the sidecar to the data branch. In `ci`
   profile, the collector is configured to mute process-scraper errors and any
   remaining expected noise is suppressed and counted in the step summary.

## Platform support

The action supports the collector platforms that the implementation knows how to
fetch today:

- Linux (`x64`, `arm64`)
- macOS (`x64`, `arm64`)
- Windows (`x64`, `arm64`)

## Relationship to stash and aggregate

- `actions/stash` stores the benchmark result itself at
  `data/runs/{run-id}/benchmark.otlp.json`
- `actions/monitor` stores raw OTLP telemetry alongside it at
  `data/runs/{run-id}/telemetry.otlp.jsonl.gz` (gzipped NDJSON)
- aggregate and chart work can then consume those sidecars through OTLP-aware
  pipelines without forcing an eager conversion to `BenchmarkResult` at capture
  time
