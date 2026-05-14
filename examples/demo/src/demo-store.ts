/**
 * Demo store: ingests deterministic incident scenario metrics into
 * a RowGroupStore for the demo gallery example.
 *
 * Gallery contract: data lives in real o11ytsdb storage, queried via ScanEngine.
 */

import type { QueryOpts, QueryResult, ValuesCodec } from "o11ytsdb";
import { RowGroupStore, ScanEngine } from "o11ytsdb";

// ── Minimal values codec ────────────────────────────────────────────
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
    const count = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    return new Float64Array(buf.buffer, buf.byteOffset + 4, count);
  },
};

// ── Deterministic sample data ───────────────────────────────────────
const NS_PER_S = 1_000_000_000n;
const START_S = 1; // seconds
const END_S = 13;

const store: RowGroupStore = new RowGroupStore(valuesCodec, 64, () => 0, 32, "demo-store");
export const engine: ScanEngine = new ScanEngine();

// ── Metric 1: checkout.inflight_requests (gauge, by route) ──────────
const inflightRoutes = ["/checkout", "/inventory", "/payment"] as const;
const inflightSeries = inflightRoutes.map((route) =>
  store.getOrCreateSeries(
    new Map([
      ["__name__", "checkout.inflight_requests"],
      ["route", route],
    ])
  )
);

const inflightData: Record<string, number[]> = {
  "/checkout": [12, 15, 22, 28, 31, 27, 19, 14, 10, 8, 6, 5, 4],
  "/inventory": [8, 10, 14, 18, 22, 20, 16, 12, 9, 7, 5, 4, 3],
  "/payment": [5, 7, 11, 16, 24, 30, 26, 20, 15, 11, 8, 6, 4],
};

for (let s = START_S; s <= END_S; s++) {
  const timestamp = BigInt(s) * NS_PER_S;
  store.append(
    new BigInt64Array([timestamp]),
    inflightSeries.map((id, i) => ({
      id,
      values: new Float64Array([inflightData[inflightRoutes[i]!]![s - START_S]!]),
    }))
  );
}

// ── Metric 2: checkout.retry_rate (gauge, by route) ─────────────────
const retrySeries = inflightRoutes.map((route) =>
  store.getOrCreateSeries(
    new Map([
      ["__name__", "checkout.retry_rate"],
      ["route", route],
    ])
  )
);

const retryData: Record<string, number[]> = {
  "/checkout": [0.5, 1.2, 2.8, 4.1, 5.3, 4.8, 3.2, 2.1, 1.4, 0.8, 0.5, 0.3, 0.2],
  "/inventory": [0.3, 0.6, 1.4, 2.2, 3.1, 2.8, 2.0, 1.3, 0.9, 0.5, 0.3, 0.2, 0.1],
  "/payment": [0.8, 1.5, 3.2, 5.6, 7.8, 8.2, 6.5, 4.3, 2.8, 1.6, 1.0, 0.6, 0.4],
};

for (let s = START_S; s <= END_S; s++) {
  const timestamp = BigInt(s) * NS_PER_S;
  store.append(
    new BigInt64Array([timestamp]),
    retrySeries.map((id, i) => ({
      id,
      values: new Float64Array([retryData[inflightRoutes[i]!]![s - START_S]!]),
    }))
  );
}

// ── Metric 3: checkout.error_rate (gauge, by route) ─────────────────
const errorSeries = inflightRoutes.map((route) =>
  store.getOrCreateSeries(
    new Map([
      ["__name__", "checkout.error_rate"],
      ["route", route],
    ])
  )
);

const errorFinalValues: Record<string, number> = {
  "/checkout": 2.1,
  "/inventory": 1.4,
  "/payment": 4.8,
};

// Single point at end for latest-values display
for (const [i, route] of inflightRoutes.entries()) {
  const timestamp = BigInt(END_S) * NS_PER_S;
  store.append(new BigInt64Array([timestamp]), [
    { id: errorSeries[i]!, values: new Float64Array([errorFinalValues[route]!]) },
  ]);
}

// ── Metric 4: checkout.request.duration_ms (gauge samples for histogram) ─
const durationSeries = store.getOrCreateSeries(
  new Map([["__name__", "checkout.request.duration_ms"]])
);

// Generate duration samples that create a realistic histogram shape
const durationSamples = [
  65, 72, 78, 85, 88, 92, 95, 98, 102, 108, 112, 118, 125, 132, 140, 148, 155, 165, 178, 192, 205,
  220, 245, 260, 285, 310,
];

for (const [i, value] of durationSamples.entries()) {
  const timestamp = BigInt(START_S + i) * NS_PER_S;
  store.append(new BigInt64Array([timestamp]), [
    { id: durationSeries, values: new Float64Array([value]) },
  ]);
}

// ── Metric 5: collector.cpu_percent (gauge, by pod) ─────────────────
const pods = ["collector-1", "collector-2"] as const;
const cpuSeries = pods.map((pod) =>
  store.getOrCreateSeries(
    new Map([
      ["__name__", "collector.cpu_percent"],
      ["pod", pod],
    ])
  )
);

const cpuData: Record<string, number[]> = {
  "collector-1": [12, 15, 22, 35, 42, 38, 28, 20, 16, 14, 12, 11, 10],
  "collector-2": [8, 10, 18, 28, 35, 32, 25, 18, 14, 11, 9, 8, 7],
};

for (let s = START_S; s <= END_S; s++) {
  const timestamp = BigInt(s) * NS_PER_S;
  store.append(
    new BigInt64Array([timestamp]),
    cpuSeries.map((id, i) => ({
      id,
      values: new Float64Array([cpuData[pods[i]!]![s - START_S]!]),
    }))
  );
}

// ── Exports ─────────────────────────────────────────────────────────
export { store };

const fullRange = { start: BigInt(START_S) * NS_PER_S, end: BigInt(END_S) * NS_PER_S };

export function queryMetric(metric: string, opts?: Partial<QueryOpts>): QueryResult {
  return engine.query(store, { metric, ...fullRange, ...opts });
}
