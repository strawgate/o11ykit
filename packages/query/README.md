# @otlpkit/query

Signal-agnostic telemetry query and reduction helpers built on top of `@otlpkit/otlpjson`.

## What It Provides

- Materialization helpers for metrics, traces, and logs
- Flexible filtering by signal, time, scope, resource, and attributes
- Grouping and latest-value selection
- Time bucketing and aggregations (`sum`, `avg`, `min`, `max`, `last`, `count`)

## Quick Example

```ts
import { bucketTimeSeries, collectMetrics, filterRecords } from "@otlpkit/query";

const records = collectMetrics(document);
const filtered = filterRecords(records, { name: "logfwd.inflight_batches" });
const series = bucketTimeSeries(filtered, { intervalMs: 1000, reduce: "avg" });
```
