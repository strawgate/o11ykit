/**
 * Shared example store: ingests deterministic sample metrics into a
 * RowGroupStore and exposes helpers for querying via ScanEngine.
 *
 * Gallery contract: every example starts from real o11ytsdb storage +
 * ScanEngine.query(...) using the optimized RowGroupStore path.
 */

import type { QueryOpts, QueryResult, ValuesCodec } from "o11ytsdb";
import { RowGroupStore, ScanEngine } from "o11ytsdb";

// ── Minimal values codec (f64 plain) ────────────────────────────────
const valuesCodec: ValuesCodec = {
  name: "f64-plain",
  encodeValues(values: Float64Array): Uint8Array {
    const out = new Uint8Array(4 + values.byteLength);
    new DataView(out.buffer).setUint32(0, values.length, true);
    out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
    return out;
  },
  decodeValues(buf: Uint8Array): Float64Array {
    if (buf.byteLength < 4) return new Float64Array(0);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = dv.getUint32(0, true);
    const requiredBytes = 4 + count * 8;
    if (buf.byteLength < requiredBytes) return new Float64Array(0);
    const result = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = dv.getFloat64(4 + i * 8, true);
    }
    return result;
  },
};

// ── Sample metric constants ─────────────────────────────────────────
const METRIC_NAME = "http.request.duration_ms";
const START_MS = 1_714_200_000_000; // deterministic epoch
const STEP_MS = 10_000; // 10-second intervals
const POINTS = 30; // 30 data points per series
const NS_PER_MS = 1_000_000n;

const SERIES = [
  { service: "checkout", route: "/cart", status: "2xx", base: 74, phase: 0.2 },
  { service: "checkout", route: "/pay", status: "5xx", base: 108, phase: 1.8 },
  { service: "api", route: "/search", status: "2xx", base: 62, phase: 2.4 },
  { service: "worker", route: "/jobs", status: "2xx", base: 88, phase: 3.1 },
];

function sampleValue(
  series: (typeof SERIES)[number],
  seriesIndex: number,
  sampleIndex: number
): number {
  return series.base + 20 * Math.sin(series.phase + sampleIndex * 0.4 + seriesIndex * 0.7);
}

// ── Build the store ─────────────────────────────────────────────────
const store: RowGroupStore = new RowGroupStore(valuesCodec, 64, () => 0, 32, "example-store");

const seriesIds = SERIES.map((s) =>
  store.getOrCreateSeries(
    new Map([
      ["__name__", METRIC_NAME],
      ["service", s.service],
      ["route", s.route],
      ["status_class", s.status],
    ])
  )
);

// Append all samples
for (let i = 0; i < POINTS; i++) {
  const timestamp = BigInt(START_MS + i * STEP_MS) * NS_PER_MS;
  store.append(
    new BigInt64Array([timestamp]),
    seriesIds.map((id, seriesIndex) => ({
      id,
      values: new Float64Array([sampleValue(SERIES[seriesIndex]!, seriesIndex, i)]),
    }))
  );
}

// ── Exports ─────────────────────────────────────────────────────────
export const engine: ScanEngine = new ScanEngine();
export { store };

/** Full time range query for the sample metric. */
export const defaultQuery: QueryOpts = {
  metric: METRIC_NAME,
  start: BigInt(START_MS) * NS_PER_MS,
  end: BigInt(START_MS + (POINTS - 1) * STEP_MS) * NS_PER_MS,
};

/** Query the store with optional overrides. */
export function query(opts?: Partial<QueryOpts>): QueryResult {
  return engine.query(store, { ...defaultQuery, ...opts });
}
