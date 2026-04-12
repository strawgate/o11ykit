# @benchkit/format

Benchmark result types and format parsers for [benchkit](../../README.md). Parses Go bench output, [Hyperfine](https://github.com/sharkdp/hyperfine) JSON, [benchmark-action](https://github.com/benchmark-action/github-action-benchmark) JSON, [pytest-benchmark](https://pytest-benchmark.readthedocs.io/) JSON, and OTLP metrics JSON into a single normalized OTLP metrics document.

## Installation

> **Note:** `@benchkit/format` is not yet published to the npm registry.
> Until the first release, install from source as described below.

Clone the repository, install dependencies, and build the package:

```bash
git clone https://github.com/strawgate/octo11y.git
cd benchkit
npm ci
npm run build --workspace=packages/format
```

Then, from your project directory, link the local package (adjust the path
to where you cloned benchkit):

```bash
npm link <path-to-benchkit>/packages/format
```

Or use a `file:` reference in your project's `package.json`:

```jsonc
{
  "dependencies": {
    "@benchkit/format": "file:<path-to-benchkit>/packages/format"
  }
}
```

Once published, you will be able to install directly:

```bash
npm install @benchkit/format
```

## Quick start

```ts
import { parseBenchmarks } from "@benchkit/format";

// Auto-detect the format and parse
const result = parseBenchmarks(input);

for (const bench of result.benchmarks) {
  for (const [name, metric] of Object.entries(bench.metrics)) {
    console.log(`${bench.name} ${name}: ${metric.value} ${metric.unit ?? ""}`);
  }
}
```

## Building OTLP results programmatically

If your benchmark does not come from a tool like `go test -bench`, you can
build OTLP results programmatically using `buildOtlpResult`:

```ts
import { buildOtlpResult } from "@benchkit/format";

const doc = buildOtlpResult({
  benchmarks: [
    {
      name: "mock-http-ingest",
      metrics: {
        events_per_sec: { value: 13240.5, unit: "events/sec" },
        p95_batch_ms: { value: 143.2, unit: "ms", direction: "smaller_is_better" },
        service_rss_mb: { value: 543.1, unit: "MB", direction: "smaller_is_better" },
      },
    },
  ],
  context: { sourceFormat: "otlp" },
});

const json = JSON.stringify(doc, null, 2);
// write json to results.json, then stash with format: otlp
```

Shorthands:

- numeric metrics like `{ parse_errors: 0 }` are accepted
- direction is inferred from `unit` when omitted, e.g. `events/sec` becomes
  `bigger_is_better`

## Parser entry points

### `parseBenchmarks(input, format?)`

Main entry point. Accepts a string and an optional format hint. When `format` is
omitted or `"auto"`, the parser inspects the input and picks the right strategy:

| Detected shape | Trigger | Format |
|---|---|---|
| JSON object with a `benchmarks` array whose entries have a `stats` object | `benchmarks[0].stats` is an object | `pytest-benchmark` |
| JSON object with a `resourceMetrics` array | Top-level `resourceMetrics` key present | `otlp` |
| JSON object with a `results` array | Top-level `results` key with objects containing a `command` string | `hyperfine` |
| JSON array of objects | Array whose first element has both a string `name` and a numeric `value` | `benchmark-action` |
| Plain text lines | Lines matching `/^Benchmark\w.*\s+\d+\s+[\d.]+\s+\w+\/\w+/` | `go` |
| Plain text lines | Lines matching `/^test\s+\S+\s+\.\.\.\s+bench:/` | `rust` |

If auto-detection fails, `parseBenchmarks` throws with a message listing the supported formats.

```ts
import { parseBenchmarks } from "@benchkit/format";

// Explicit format
const result = parseBenchmarks(goOutput, "go");

// Auto-detect (default)
const result = parseBenchmarks(unknownInput);
```

### `parseOtlp(input)`

Parses OTLP metrics JSON and provides helpers for:

- reading resource and datapoint attributes
- discriminating metric kinds (`gauge`, `sum`, `histogram`)
- reading aggregation temporality

```ts
import { parseOtlp } from "@benchkit/format";

const document = parseOtlp(otlpJson);
```

### `parseGoBench(input)`

Parses Go `testing.B` text output. Each benchmark line produces one `Benchmark`
entry. The `-P` processor suffix is extracted into a `procs` tag. Multiple
value/unit pairs on the same line produce separate named metrics.

**Input** (typical `go test -bench=. -benchmem` output):

```
goos: linux
goarch: amd64
BenchmarkSort/small-8     500000     2345 ns/op     128 B/op     3 allocs/op
BenchmarkSort/large-8       1000   987654 ns/op   65536 B/op   512 allocs/op
BenchmarkHash-8          1000000      890 ns/op       0 B/op     0 allocs/op
PASS
ok  	example.com/mypackage	3.456s
```

**Call:**

```ts
import { parseGoBench } from "@benchkit/format";

const input = `
BenchmarkSort/small-8     500000     2345 ns/op     128 B/op     3 allocs/op
BenchmarkSort/large-8       1000   987654 ns/op   65536 B/op   512 allocs/op
BenchmarkHash-8          1000000      890 ns/op       0 B/op     0 allocs/op
`.trim();

const result = parseGoBench(input);
```

**Result** (abbreviated):

```json
{
  "benchmarks": [
    {
      "name": "BenchmarkSort/small",
      "tags": { "procs": "8" },
      "metrics": {
        "ns_per_op":     { "value": 2345,   "unit": "ns/op",     "direction": "smaller_is_better" },
        "bytes_per_op":  { "value": 128,    "unit": "B/op",      "direction": "smaller_is_better" },
        "allocs_per_op": { "value": 3,      "unit": "allocs/op", "direction": "smaller_is_better" }
      }
    },
    {
      "name": "BenchmarkSort/large",
      "tags": { "procs": "8" },
      "metrics": {
        "ns_per_op":     { "value": 987654, "unit": "ns/op",     "direction": "smaller_is_better" },
        "bytes_per_op":  { "value": 65536,  "unit": "B/op",      "direction": "smaller_is_better" },
        "allocs_per_op": { "value": 512,    "unit": "allocs/op", "direction": "smaller_is_better" }
      }
    },
    {
      "name": "BenchmarkHash",
      "tags": { "procs": "8" },
      "metrics": {
        "ns_per_op":     { "value": 890, "unit": "ns/op", "direction": "smaller_is_better" },
        "bytes_per_op":  { "value": 0,   "unit": "B/op",  "direction": "smaller_is_better" },
        "allocs_per_op": { "value": 0,   "unit": "allocs/op", "direction": "smaller_is_better" }
      }
    }
  ]
}
```

### `parseBenchmarkAction(input)`

Parses the JSON array format used by
[benchmark-action/github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark).
Each array entry becomes one `Benchmark` with a single metric called `value`.
The `range` string (e.g. `"± 300"`) is parsed into a numeric `range` field.

**Input** (JSON produced by the benchmark tool):

```json
[
  { "name": "encode/small",  "value": 125430, "unit": "ops/sec", "range": "± 1200" },
  { "name": "encode/medium", "value":  48200, "unit": "ops/sec", "range": "± 480" },
  { "name": "decode/small",  "value":  98700, "unit": "ops/sec" },
  { "name": "latency/p99",   "value":    4.2, "unit": "ms",      "range": "+/- 0.3" }
]
```

**Call:**

```ts
import { parseBenchmarkAction } from "@benchkit/format";

const result = parseBenchmarkAction(input);
```

**Result** (abbreviated):

```json
{
  "benchmarks": [
    {
      "name": "encode/small",
      "metrics": {
        "value": { "value": 125430, "unit": "ops/sec", "direction": "bigger_is_better", "range": 1200 }
      }
    },
    {
      "name": "encode/medium",
      "metrics": {
        "value": { "value": 48200, "unit": "ops/sec", "direction": "bigger_is_better", "range": 480 }
      }
    },
    {
      "name": "decode/small",
      "metrics": {
        "value": { "value": 98700, "unit": "ops/sec", "direction": "bigger_is_better" }
      }
    },
    {
      "name": "latency/p99",
      "metrics": {
        "value": { "value": 4.2, "unit": "ms", "direction": "smaller_is_better", "range": 0.3 }
      }
    }
  ]
}
```

### `parseRustBench(input)`

Parses Rust `cargo bench` (libtest) text output. Each benchmark line produces one
`Benchmark` entry.

```ts
import { parseRustBench } from "@benchkit/format";

const result = parseRustBench(
  "test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)"
);
// result.benchmarks[0].metrics => { ns_per_iter: { value: 320, unit: "ns/iter", range: 42 } }
```

### `parseHyperfine(input)`

Parses the JSON export from [Hyperfine](https://github.com/sharkdp/hyperfine)
(`hyperfine --export-json`). Each result becomes a benchmark named after the
command, with `mean`, `stddev`, `median`, `min`, and `max` metrics.

```ts
import { parseHyperfine } from "@benchkit/format";

const result = parseHyperfine(JSON.stringify({
  results: [
    {
      command: "sleep 0.1",
      mean: 0.105,
      stddev: 0.002,
      median: 0.105,
      min: 0.103,
      max: 0.108,
      times: [0.103, 0.105, 0.108]
    }
  ]
}));
```

### `parsePytestBenchmark(input)`

Parses [pytest-benchmark](https://pytest-benchmark.readthedocs.io/) JSON output
(`pytest --benchmark-json=results.json`). Each benchmark entry becomes a
`Benchmark` with metrics for `mean` (primary, seconds), `ops`, `rounds`,
`median`, `min`, `max`, and `stddev`.

```ts
import { parsePytestBenchmark } from "@benchkit/format";

const result = parsePytestBenchmark(JSON.stringify({
  benchmarks: [
    {
      name: "test_sort",
      fullname: "tests/test_perf.py::test_sort",
      stats: {
        min: 0.000123,
        max: 0.000156,
        mean: 0.000134,
        stddev: 0.0000089,
        rounds: 1000,
        median: 0.000132,
        ops: 7462.68
      }
    }
  ]
}));
// result.benchmarks[0].metrics.mean  => { value: 0.000134, unit: "s", direction: "smaller_is_better", range: 0.0000089 }
// result.benchmarks[0].metrics.ops   => { value: 7462.68, unit: "ops/s", direction: "bigger_is_better" }
// result.benchmarks[0].metrics.rounds => { value: 1000, direction: "bigger_is_better" }
```

**Python example** — generate and consume pytest-benchmark output:

```python
# conftest.py / test_perf.py
def test_sort(benchmark):
    benchmark(sorted, range(1000))
```

```bash
pytest --benchmark-json=results.json
```

```ts
import { readFileSync } from "fs";
import { parsePytestBenchmark } from "@benchkit/format";

const result = parsePytestBenchmark(readFileSync("results.json", "utf-8"));
for (const bench of result.benchmarks) {
  console.log(`${bench.name}: ${bench.metrics.mean.value}s (${bench.metrics.ops.value} ops/s)`);
}
```

### `inferDirection(unit)`

Infers whether a unit string represents a "bigger is better" or "smaller is
better" metric. Used internally by all parsers when no explicit `direction` is
provided.

```ts
import { inferDirection } from "@benchkit/format";

inferDirection("ops/sec");   // "bigger_is_better"
inferDirection("MB/s");      // "bigger_is_better"
inferDirection("throughput"); // "bigger_is_better"
inferDirection("ns/op");     // "smaller_is_better"
inferDirection("ms");        // "smaller_is_better"
inferDirection("B/op");      // "smaller_is_better"
```

The heuristic scans the lowercased unit string for substrings:

| Matched substring | Direction | Example units |
|---|---|---|
| `ops/s` | `bigger_is_better` | `ops/sec`, `ops/s` |
| `op/s` | `bigger_is_better` | `op/sec`, `op/s` |
| `/sec` | `bigger_is_better` | `req/sec`, `events/sec` |
| `mb/s` | `bigger_is_better` | `MB/s`, `mb/s` |
| `throughput` | `bigger_is_better` | `throughput` |
| `events` | `bigger_is_better` | `events`, `events/sec` |
| _(no match)_ | `smaller_is_better` | `ns/op`, `ms`, `B/op`, `allocs/op`, `ns/iter`, `bytes` |

## Types

All types mirror the JSON schemas in [`schema/`](../../schema/README.md).

### `compareRuns(current, baseline[], config?)`

Compare a current benchmark run against one or more baseline runs.

```ts
import { compareRuns } from "@benchkit/format";

const result = compareRuns(current, [baseline]);
if (result.hasRegression) {
  console.log("Regressions detected!");
}
```

### `Sample`

A time-series data point within a benchmark run. `t` is seconds since
benchmark start; all other keys are metric values at that instant.

```ts
interface Sample {
  t: number;
  [metricName: string]: number;
}
```

### `MonitorContext`

Metadata about the resource monitoring context (when monitor output is merged via stash action).

```ts
interface MonitorContext {
  monitor_version: string;
  poll_interval_ms: number;
  duration_ms: number;
  runner_os?: string;
  runner_arch?: string;
  poll_count?: number;
  kernel?: string;
  cpu_model?: string;
  cpu_count?: number;
  total_memory_mb?: number;
}
```

### Series and index types

These types describe the aggregated files on the `bench-data` branch (see
[Data files](#data-files) below):

| Type | Schema | Purpose |
|---|---|---|
| `IndexFile` | [`index.schema.json`](../../schema/index.schema.json) | Run listing with per-run metadata |
| `RunEntry` | (inline in index schema) | Single entry inside `IndexFile.runs` |
| `SeriesFile` | [`series.schema.json`](../../schema/series.schema.json) | Pre-aggregated time-series for one metric |
| `SeriesEntry` | (inline in series schema) | Points array for one benchmark within a series |
| `DataPoint` | (inline in series schema) | Single `{timestamp, value}` point |

## Metric naming conventions

When the Go and benchmark-action parsers normalize metrics they apply these
rules:

| Go unit | Metric name | Rule |
|---|---|---|
| `ns/op` | `ns_per_op` | Replace `/` with `_per_`, lowercase |
| `B/op` | `bytes_per_op` | Known alias |
| `allocs/op` | `allocs_per_op` | Replace `/` with `_per_`, lowercase |
| `MB/s` | `mb_per_s` | Known alias |

General algorithm: replace every `/` with `_per_`, replace spaces with `_`,
then lowercase. Specific aliases (`B/op` → `bytes_per_op`, `MB/s` → `mb_per_s`, `ns/iter` → `ns_per_iter`)
take precedence.

## Direction semantics

Every metric may declare whether higher or lower values represent improvement.

| Direction | Meaning | Examples |
|---|---|---|
| `bigger_is_better` | Higher values are improvements | throughput, ops/sec, MB/s |
| `smaller_is_better` | Lower values are improvements | latency, ns/op, allocations |

When direction is not specified in the input, all parsers call `inferDirection(unit)`
to infer it from the unit string. See the [`inferDirection` section](#inferdirectionunit)
for the full list of recognized unit patterns.

If no unit is provided and no direction is set, consumers should treat the
metric as `smaller_is_better`.

## Data files

The `bench-stash` and `bench-aggregate` actions maintain a set of JSON files
on a dedicated Git branch (default `bench-data`). The branch layout is:

```
data/
├── index.json              # All runs (IndexFile)
├── runs/
│   ├── {runId}/
│   │   ├── benchmark.otlp.json     # OTLP benchmark metrics JSON for one run
│   │   └── telemetry.otlp.jsonl.gz # Optional OTLP telemetry sidecar
│   └── ...
└── series/
    ├── {metricName}.json   # Time-series for one metric (SeriesFile)
    └── ...
```

| File | Schema | Written by |
|---|---|---|
| `data/index.json` | [`index.schema.json`](../../schema/index.schema.json) | `bench-aggregate` |
| `data/runs/{id}/benchmark.otlp.json` | OTLP metrics JSON | `bench-stash` |
| `data/series/{metric}.json` | [`series.schema.json`](../../schema/series.schema.json) | `bench-aggregate` |

## Validating your own output

Validate aggregated output against the JSON schemas:

```bash
npx ajv validate -s schema/index.schema.json -d data/index.json
npx ajv validate -s schema/series.schema.json -d data/series/ns_per_op.json
```

## License

MIT
