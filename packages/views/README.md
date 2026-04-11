# @otlpkit/views

Build reusable telemetry view frames from OTLP JSON inputs.

## What It Provides

- `buildTimeSeriesFrame`
- `mergeTimeSeriesFrames`
- `appendTimeSeriesFrame`
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

## Incremental Updates

When new telemetry slices arrive, you can merge them into an existing frame instead of rebuilding
from your full history on every update.

```ts
import {
  appendTimeSeriesFrame,
  buildTimeSeriesFrame,
  mergeTimeSeriesFrames,
} from "@otlpkit/views";

const base = buildTimeSeriesFrame(initialDoc, {
  metricName: "http.server.duration",
  splitBy: "resource.service.name",
  intervalMs: 10_000,
});

// Option 1: append raw incoming OTLP input directly.
const updated = appendTimeSeriesFrame(base, newDocSlice, {
  metricName: "http.server.duration",
  splitBy: "resource.service.name",
});

// Option 2: build a delta frame, then merge explicitly.
const delta = buildTimeSeriesFrame(newDocSlice, {
  metricName: "http.server.duration",
  splitBy: "resource.service.name",
  intervalMs: 10_000,
});

const merged = mergeTimeSeriesFrames(base, delta, {
  onConflict: "replace", // default
});
```
