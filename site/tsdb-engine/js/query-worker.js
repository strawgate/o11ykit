import { ScanEngine } from "./query.js";
import { createWorkerSnapshotStore } from "./query-worker-store.js";

let store = await createWorkerSnapshotStore("raw");
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
  const seen = new Set();
  for (const series of result.series) {
    if (!seen.has(series.timestamps.buffer)) {
      seen.add(series.timestamps.buffer);
      transfer.push(series.timestamps.buffer);
    }
    if (!seen.has(series.values.buffer)) {
      seen.add(series.values.buffer);
      transfer.push(series.values.buffer);
    }
  }
  return transfer;
}

function combineTransferables(...groups) {
  const transfer = [];
  const seen = new Set();
  for (const group of groups) {
    for (const buffer of group) {
      if (seen.has(buffer)) continue;
      seen.add(buffer);
      transfer.push(buffer);
    }
  }
  return transfer;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "load-partition": {
      store = await createWorkerSnapshotStore(message.kind || "raw");
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
        const partials = engine.queryAveragePartials(store, opts);
        const payload = {
          type: "query-result",
          queryId: message.queryId,
          workerId: message.workerId,
          durationMs: performance.now() - startedAt,
          kind: "avg",
          sum: serializeResult(partials.sum),
          count: serializeResult(partials.count),
        };
        const transfer = combineTransferables(
          resultTransferables(payload.sum),
          resultTransferables(payload.count)
        );
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
}

self.addEventListener("message", (event) => {
  const message = event.data;
  void handleMessage(message).catch((error) => {
    setTimeout(() => {
      throw error;
    });
  });
});
