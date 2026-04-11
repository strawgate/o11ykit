# @otlpkit/otlpjson

OTLP JSON parsing, normalization, and typed iterators for metrics, traces, and logs.

## What It Provides

- Signal detection for OTLP JSON documents (`metrics`, `traces`, `logs`)
- JSON/JSONL parsing helpers
- Typed record iterators and collectors
- Timestamp normalization (`unix_nano` as string)
- Attribute flattening into plain JavaScript values

## Quick Example

```ts
import { collectMetricPoints, parseOtlpJson } from "@otlpkit/otlpjson";

const document = parseOtlpJson(rawJsonText);
const points = collectMetricPoints(document);
```
