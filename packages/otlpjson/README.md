# @otlpkit/otlpjson

OTLP JSON parsing, normalization, and typed iterators for metrics, traces, and logs.

## What It Provides

- Signal detection for OTLP JSON documents (`metrics`, `traces`, `logs`)
- JSON/JSONL parsing helpers
- Low-allocation visitor APIs for hot-path consumers
- Typed record iterators and collectors
- Timestamp normalization (`unix_nano` as string)
- Attribute flattening into plain JavaScript values

## Quick Example

```ts
import { collectMetricPoints, parseOtlpJson } from "@otlpkit/otlpjson";

const document = parseOtlpJson(rawJsonText);
const points = collectMetricPoints(document);
```

For hot-path metrics ingestion, use the visitor layer instead of materializing
full metric point records:

```ts
import { visitMetricPoints } from "@otlpkit/otlpjson";

visitMetricPoints(document, {
  onNumberDataPoints(context, points) {
    console.log(context.metric.name, points.length);
  },
});
```
