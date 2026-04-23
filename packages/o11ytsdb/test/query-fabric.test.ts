import { describe, expect, it } from "vitest";

import type { QueryExecutor } from "../src/query-fabric.js";
import {
  PassThroughReducer,
  QueryFabric,
  SingleExecutorRouter,
  TimePartitionRouter,
} from "../src/query-fabric.js";
import type { Labels, QueryOpts, QueryResult } from "../src/types.js";

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const labels = new Map<string, string>();
  labels.set("__name__", name);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      labels.set(key, value);
    }
  }
  return labels;
}

function makeSeries(
  labels: Labels,
  points: ReadonlyArray<readonly [timestamp: bigint, value: number]>
): QueryResult["series"][number] {
  return {
    labels,
    timestamps: BigInt64Array.from(points.map(([timestamp]) => timestamp)),
    values: Float64Array.from(points.map(([, value]) => value)),
  };
}

function makeExecutor(
  responder: (opts: QueryOpts) => QueryResult | Promise<QueryResult>
): QueryExecutor {
  return {
    query(opts: QueryOpts): QueryResult | Promise<QueryResult> {
      return responder(opts);
    },
  };
}

describe("QueryFabric", () => {
  it("delegates directly through a single executor router", async () => {
    const seen: QueryOpts[] = [];
    const executor = makeExecutor((opts) => {
      seen.push(opts);
      return {
        series: [makeSeries(makeLabels("cpu", { host: "a" }), [[opts.start, 10]])],
        scannedSeries: 1,
        scannedSamples: 1,
      };
    });

    const fabric = new QueryFabric(new SingleExecutorRouter(executor));
    const result = await fabric.execute({ metric: "cpu", start: 10n, end: 20n });

    expect(seen).toEqual([{ metric: "cpu", start: 10n, end: 20n }]);
    expect(result.series).toHaveLength(1);
    const firstSeries = result.series[0];
    expect(firstSeries).toBeDefined();
    expect(firstSeries?.timestamps[0]).toBe(10n);
    expect(firstSeries?.values[0]).toBe(10);
  });

  it("throws when pass-through reduction sees multiple partials", () => {
    const reducer = new PassThroughReducer();
    expect(() =>
      reducer.reduce({ metric: "cpu", start: 0n, end: 10n }, [
        {
          worker: makeExecutor(() => ({ series: [], scannedSeries: 0, scannedSamples: 0 })),
          request: { metric: "cpu", start: 0n, end: 5n },
          result: { series: [], scannedSeries: 0, scannedSamples: 0 },
        },
        {
          worker: makeExecutor(() => ({ series: [], scannedSeries: 0, scannedSamples: 0 })),
          request: { metric: "cpu", start: 6n, end: 10n },
          result: { series: [], scannedSeries: 0, scannedSamples: 0 },
        },
      ])
    ).toThrow("exactly 1 partial");
  });

  it("dispatches overlapping partition windows and clips merged output", async () => {
    const seenFrozen: QueryOpts[] = [];
    const seenHot: QueryOpts[] = [];

    const frozen = makeExecutor((opts) => {
      seenFrozen.push(opts);
      return {
        series: [
          makeSeries(makeLabels("cpu", { host: "a" }), [
            [20n, 1],
            [49n, 2],
          ]),
        ],
        scannedSeries: 1,
        scannedSamples: 2,
      };
    });
    const hot = makeExecutor((opts) => {
      seenHot.push(opts);
      return {
        series: [
          makeSeries(makeLabels("cpu", { host: "a" }), [
            [50n, 3],
            [80n, 4],
          ]),
        ],
        scannedSeries: 1,
        scannedSamples: 2,
      };
    });

    const fabric = new QueryFabric(
      new TimePartitionRouter([
        { worker: frozen, start: 0n, end: 49n },
        { worker: hot, start: 50n, end: 99n },
      ])
    );

    const result = await fabric.execute({ metric: "cpu", start: 20n, end: 80n });

    expect(seenFrozen).toEqual([{ metric: "cpu", start: 0n, end: 49n }]);
    expect(seenHot).toEqual([{ metric: "cpu", start: 50n, end: 99n }]);
    const firstSeries = result.series[0];
    expect(firstSeries).toBeDefined();
    expect([...new BigInt64Array(firstSeries?.timestamps ?? [])]).toEqual([20n, 49n, 50n, 80n]);
    expect([...new Float64Array(firstSeries?.values ?? [])]).toEqual([1, 2, 3, 4]);
    expect(result.scannedSeries).toBe(1);
    expect(result.scannedSamples).toBe(4);
  });

  it("uses assignment priority to let hot overlap override frozen points", async () => {
    const frozen = makeExecutor(() => ({
      series: [
        makeSeries(makeLabels("cpu", { host: "a" }), [
          [40n, 1],
          [50n, 1],
          [60n, 1],
        ]),
      ],
      scannedSeries: 1,
      scannedSamples: 3,
    }));
    const hot = makeExecutor(() => ({
      series: [
        makeSeries(makeLabels("cpu", { host: "a" }), [
          [50n, 9],
          [60n, 9],
          [70n, 9],
        ]),
      ],
      scannedSeries: 1,
      scannedSamples: 3,
    }));

    const fabric = new QueryFabric(
      new TimePartitionRouter([
        { worker: frozen, start: 0n, end: 60n, priority: 0 },
        { worker: hot, start: 50n, end: 100n, priority: 1 },
      ])
    );

    const result = await fabric.execute({ metric: "cpu", start: 40n, end: 70n });

    const firstSeries = result.series[0];
    expect(firstSeries).toBeDefined();
    expect([...new BigInt64Array(firstSeries?.timestamps ?? [])]).toEqual([40n, 50n, 60n, 70n]);
    expect([...new Float64Array(firstSeries?.values ?? [])]).toEqual([1, 9, 9, 9]);
    expect(result.scannedSeries).toBe(1);
    expect(result.scannedSamples).toBe(6);
  });

  it("merges multiple label groups independently", async () => {
    const frozen = makeExecutor(() => ({
      series: [
        makeSeries(makeLabels("cpu", { host: "a" }), [[10n, 1]]),
        makeSeries(makeLabels("cpu", { host: "b" }), [[10n, 2]]),
      ],
      scannedSeries: 2,
      scannedSamples: 2,
    }));
    const hot = makeExecutor(() => ({
      series: [
        makeSeries(makeLabels("cpu", { host: "a" }), [[20n, 3]]),
        makeSeries(makeLabels("cpu", { host: "b" }), [[20n, 4]]),
      ],
      scannedSeries: 2,
      scannedSamples: 2,
    }));

    const fabric = new QueryFabric(
      new TimePartitionRouter([
        { worker: frozen, start: 0n, end: 19n },
        { worker: hot, start: 20n, end: 40n },
      ])
    );

    const result = await fabric.execute({ metric: "cpu", start: 0n, end: 40n });

    expect(result.series).toHaveLength(2);
    const byHost = new Map(result.series.map((series) => [series.labels.get("host"), series]));
    const hostA = byHost.get("a");
    const hostB = byHost.get("b");
    expect(hostA).toBeDefined();
    expect(hostB).toBeDefined();
    expect([...new BigInt64Array(hostA?.timestamps ?? [])]).toEqual([10n, 20n]);
    expect([...new Float64Array(hostA?.values ?? [])]).toEqual([1, 3]);
    expect([...new BigInt64Array(hostB?.timestamps ?? [])]).toEqual([10n, 20n]);
    expect([...new Float64Array(hostB?.values ?? [])]).toEqual([2, 4]);
    expect(result.scannedSeries).toBe(2);
    expect(result.scannedSamples).toBe(4);
  });
});
