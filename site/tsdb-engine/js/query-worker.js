import { ScanEngine } from "./query.js";
import { lowerBound, upperBound } from "./utils.js";

class PartitionStore {
  constructor() {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;
  }

  loadSeries(entries) {
    this._series = [];
    this._labels = [];
    this._postings = new Map();
    this._sampleCount = 0;

    for (const entry of entries) {
      const id = this._series.length;
      const labels = new Map(entry.labels);
      this._series.push({
        timestamps: entry.timestamps,
        values: entry.values,
      });
      this._labels.push(labels);
      this._sampleCount += entry.timestamps.length;
      for (const [key, value] of labels) {
        const postingKey = `${key}\0${value}`;
        if (!this._postings.has(postingKey)) this._postings.set(postingKey, []);
        this._postings.get(postingKey).push(id);
      }
    }
  }

  get seriesCount() {
    return this._series.length;
  }

  get sampleCount() {
    return this._sampleCount;
  }

  matchLabel(label, value) {
    return this._postings.get(`${label}\0${value}`) ?? [];
  }

  read(id, start, end) {
    const series = this._series[id];
    const lo = lowerBound(series.timestamps, start, 0, series.timestamps.length);
    const hi = upperBound(series.timestamps, end, lo, series.timestamps.length);
    return {
      timestamps: series.timestamps.slice(lo, hi),
      values: series.values.slice(lo, hi),
    };
  }

  labels(id) {
    return this._labels[id];
  }
}

const store = new PartitionStore();
const engine = new ScanEngine();

function serializeSeries(series) {
  return {
    labels: [...series.labels.entries()],
    timestamps: series.timestamps,
    values: series.values,
  };
}

function serializeResult(result) {
  return {
    scannedSeries: result.scannedSeries,
    scannedSamples: result.scannedSamples,
    requestedStep: result.requestedStep ?? null,
    effectiveStep: result.effectiveStep ?? null,
    pointBudget: result.pointBudget ?? null,
    series: result.series.map(serializeSeries),
  };
}

function resultTransferables(result) {
  const transfer = [];
  for (const series of result.series) {
    transfer.push(series.timestamps.buffer, series.values.buffer);
  }
  return transfer;
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "load-partition": {
      store.loadSeries(message.series);
      self.postMessage({
        type: "load-ack",
        workerId: message.workerId,
        seriesCount: store.seriesCount,
        sampleCount: store.sampleCount,
      });
      return;
    }

    case "query": {
      const startedAt = performance.now();
      const opts = message.opts;

      if (opts.agg === "avg") {
        const sum = engine.query(store, { ...opts, agg: "sum" });
        const count = engine.query(store, { ...opts, agg: "count" });
        const payload = {
          type: "query-result",
          queryId: message.queryId,
          workerId: message.workerId,
          durationMs: performance.now() - startedAt,
          kind: "avg",
          sum: serializeResult(sum),
          count: serializeResult(count),
        };
        const transfer = [
          ...resultTransferables(payload.sum),
          ...resultTransferables(payload.count),
        ];
        self.postMessage(payload, transfer);
        return;
      }

      const result = engine.query(store, opts);
      const payload = {
        type: "query-result",
        queryId: message.queryId,
        workerId: message.workerId,
        durationMs: performance.now() - startedAt,
        kind: "result",
        result: serializeResult(result),
      };
      self.postMessage(payload, resultTransferables(payload.result));
      return;
    }
  }
});
