# Benchkit Emit Metric

Emit a single OTLP metric to the collector started by
[`actions/monitor`](../monitor). This is the lightweight path for one-off custom
values like "this test scored 74" without forcing users to wire up a full OTLP
SDK inside benchmark code.

## Usage

```yaml
- name: Start monitor
  id: monitor
  uses: strawgate/octo11y/actions/monitor@main-dist

- name: Emit score metric
  uses: strawgate/octo11y/actions/emit-metric@main-dist
  with:
    otlp-http-endpoint: ${{ steps.monitor.outputs.otlp-http-endpoint }}
    name: test_score
    value: 74
    unit: points
    scenario: search-relevance
    series: baseline
    direction: bigger_is_better
    attributes: |
      dataset=wiki
      variant=bm25
```

The action sends OTLP/HTTP to the collector's `/v1/metrics` endpoint. Benchkit
resource attributes such as `benchkit.run_id`, `benchkit.kind`,
`benchkit.source_format=otlp`, `benchkit.ref`, `benchkit.commit`,
`benchkit.workflow`, and `benchkit.job` are added automatically.

## Inputs

See [`action.yml`](action.yml) for the full input contract. The most important
inputs are:

- `name`
- `value`
- `scenario`
- `series`
- `direction`
- `attributes`
- `otlp-http-endpoint`

`scenario` defaults to the metric name, `series` defaults to `GITHUB_JOB` (or
`default` locally), and `direction` is inferred from the unit or metric name
when omitted.
