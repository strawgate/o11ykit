# @otlpkit/views

Build reusable telemetry view frames from OTLP JSON inputs.

## What It Provides

- `buildTimeSeriesFrame`
- `buildLatestValuesFrame`
- `buildHistogramFrame`
- `buildTraceWaterfallFrame`
- `buildEventTimelineFrame`

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
