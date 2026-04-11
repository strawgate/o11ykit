import type { TraceWaterfallFrame } from "@otlpkit/views";

export interface TraceLaneRow {
  readonly traceId: string;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly label: string | null;
  readonly depth: number;
  readonly startMs: number | null;
  readonly durationMs: number | null;
  readonly statusCode: number | null;
}

export function traceWaterfallToLaneRows(frame: TraceWaterfallFrame): TraceLaneRow[] {
  return frame.traces.flatMap((trace) =>
    trace.spans.map((span) => ({
      traceId: trace.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      label: span.name,
      depth: span.depth,
      startMs: span.startOffsetMs,
      durationMs: span.durationMs,
      statusCode: span.status.code,
    }))
  );
}
