# @otlpkit/views

Build reusable telemetry view frames from OTLP JSON inputs.

## What It Provides

- `buildTimeSeriesFrame`
- `buildLatestValuesFrame`
- `buildHistogramFrame`
- `buildTraceWaterfallFrame`
- `buildEventTimelineFrame`
- `createTelemetryStore`

Frames are plain JavaScript objects designed to be consumed by UI adapters.

## Quick Example

```ts
import { buildTimeSeriesFrame } from "@otlpkit/views";

const frame = buildTimeSeriesFrame(document, {
  metricName: "logfwd.inflight_batches",
  intervalMs: 1000,
  splitBy: "output",
});
```

## Incremental Ingest Store

Use `createTelemetryStore` when telemetry arrives in chunks and you want
append-only ingest with reusable selectors.

```ts
import { createTelemetryStore } from "@otlpkit/views";

const store = createTelemetryStore({
  maxPoints: 10_000,
  maxAgeMs: 5 * 60_000,
});

store.ingest(firstOtlpChunk);
store.ingest(nextOtlpChunk);

const timeSeries = store.selectTimeSeries({
  metricName: "logfwd.inflight_batches",
  intervalMs: 1000,
});

const latest = store.selectLatestValues({
  metricName: "logfwd.inflight_batches",
});
```

Store selectors map directly to existing frame builders:

- `selectTimeSeries`
- `selectLatestValues`
- `selectHistogram`
- `selectTraceWaterfall`
- `selectEventTimeline`
