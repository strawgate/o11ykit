import { afterEach, describe, expect, it } from "vitest";
import { deriveTopologyPlan, QueryWorkerPool } from "../js/query-pool.js";
import { FlatStore } from "../js/stores.js";

class FakeWorker {
  static instances = [];

  constructor() {
    this.listeners = { message: [], error: [] };
    this.loaded = false;
    this.queryBeforeLoad = false;
    this.series = [];
    this.sampleCount = 0;
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners[type]?.push(listener);
  }

  postMessage(message) {
    if (message.type === "load-partition") {
      setTimeout(() => {
        this.loaded = true;
        this.series = message.series;
        this.sampleCount = message.series.reduce((sum, entry) => {
          if (entry.timestamps) return sum + entry.timestamps.length;
          const frozen =
            entry.frozen?.reduce((chunkSum, chunk) => chunkSum + (chunk.count || 0), 0) || 0;
          const hot = entry.hot?.count || 0;
          return sum + frozen + hot;
        }, 0);
        this.#emit("message", {
          type: "load-ack",
          workerId: message.workerId,
          seriesCount: message.series.length,
          sampleCount: this.sampleCount,
        });
      }, 15);
      return;
    }

    if (message.type === "query") {
      if (!this.loaded) this.queryBeforeLoad = true;
      setTimeout(() => {
        this.#emit("message", {
          type: "query-result",
          queryId: message.queryId,
          workerId: message.workerId,
          durationMs: 1,
          kind: "result",
          result: {
            scannedSeries: this.series.length,
            scannedSamples: this.sampleCount,
            requestedStep: message.opts.step ?? null,
            effectiveStep: message.opts.step ?? null,
            pointBudget: message.opts.maxPoints ?? null,
            series: [],
          },
        });
      }, 0);
    }
  }

  terminate() {}

  #emit(type, data) {
    for (const listener of this.listeners[type] || []) {
      listener({ data });
    }
  }
}

class FailingLoadWorker extends FakeWorker {
  postMessage(message) {
    if (message.type === "load-partition") {
      setTimeout(() => {
        this.listeners.error?.forEach((listener) => {
          listener(new Error("worker failed"));
        });
      }, 0);
      return;
    }
    super.postMessage(message);
  }
}

function buildStore(seriesCount = 4) {
  const store = new FlatStore();
  for (let i = 0; i < seriesCount; i++) {
    const id = store.getOrCreateSeries(
      new Map([
        ["__name__", "cpu"],
        ["host", `node-${i}`],
      ])
    );
    store.appendBatch(id, new BigInt64Array([1n, 2n, 3n]), new Float64Array([1, 2, 3]));
  }
  return store;
}

describe("QueryWorkerPool", () => {
  const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;

  afterEach(() => {
    FakeWorker.instances = [];
    delete globalThis.Worker;
    if (originalSharedArrayBuffer) {
      globalThis.SharedArrayBuffer = originalSharedArrayBuffer;
    } else {
      delete globalThis.SharedArrayBuffer;
    }
  });

  it("waits for workers to finish provisioning before dispatching a query", async () => {
    globalThis.Worker = FakeWorker;
    const pool = new QueryWorkerPool();
    const store = buildStore();

    const loadPromise = pool.loadStore(store);
    const queryPromise = pool.query({
      metric: "cpu",
      start: 0n,
      end: 10n,
      agg: "sum",
      groupBy: [],
      step: 1n,
      maxPoints: 100,
    });

    await loadPromise;
    const responses = await queryPromise;

    expect(responses).toHaveLength(1);
    expect(responses[0].result.scannedSeries).toBe(4);
    expect(FakeWorker.instances[0]?.queryBeforeLoad).toBe(false);

    await pool.dispose();
  });

  it("provisions workers even when SharedArrayBuffer is unavailable", async () => {
    globalThis.Worker = FakeWorker;
    delete globalThis.SharedArrayBuffer;

    const pool = new QueryWorkerPool();
    await pool.loadStore(buildStore());

    expect(pool.state.phase).toBe("ready");
    expect(pool.state.workers[0]?.seriesCount).toBe(4);

    await pool.dispose();
  });

  it("derives the expected topology from worker count", () => {
    const capabilities = {
      workers: true,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
      hardwareConcurrency: 8,
    };

    expect(
      deriveTopologyPlan({ seriesCount: 64, requestedWorkers: 1, capabilities }).topology
    ).toBe("single-worker");
    expect(
      deriveTopologyPlan({ seriesCount: 64, requestedWorkers: 2, capabilities }).topology
    ).toBe("split");
    expect(
      deriveTopologyPlan({ seriesCount: 64, requestedWorkers: 4, capabilities }).topology
    ).toBe("pooled");
  });

  it("auto-selects half the reported cpus up to four workers", () => {
    const plan = deriveTopologyPlan({
      seriesCount: 64,
      requestedWorkers: "auto",
      capabilities: {
        workers: true,
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
        hardwareConcurrency: 12,
      },
    });

    expect(plan.actualWorkers).toBe(4);
    expect(plan.transport).toBe("shared-frozen");
  });

  it("falls back to the auto worker count when requestedWorkers is invalid", () => {
    const plan = deriveTopologyPlan({
      seriesCount: 64,
      requestedWorkers: "foo",
      capabilities: {
        workers: true,
        sharedArrayBuffer: false,
        crossOriginIsolated: false,
        hardwareConcurrency: 8,
      },
    });

    expect(plan.actualWorkers).toBe(4);
  });

  it("reports inline transport when worker count resolves to zero", () => {
    const plan = deriveTopologyPlan({
      seriesCount: 64,
      requestedWorkers: 0,
      capabilities: {
        workers: true,
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
        hardwareConcurrency: 8,
      },
    });

    expect(plan.topology).toBe("inline");
    expect(plan.transport).toBe("inline");
  });

  it("resolves loadStore after switching to fallback on worker load failure", async () => {
    globalThis.Worker = FailingLoadWorker;

    const pool = new QueryWorkerPool();
    await expect(pool.loadStore(buildStore())).resolves.toBeUndefined();
    expect(pool.state.phase).toBe("fallback");

    await pool.dispose();
  });
});
