function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function chooseWorkerCount(seriesCount) {
  const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const desired = Math.max(1, hw - 1);
  if (seriesCount < 16) return 1;
  return clamp(desired, 2, 4);
}

export function supportsParallelQuery(opts) {
  return !["last", "p50", "p95", "p99"].includes(opts.agg || "");
}

export class QueryWorkerPool {
  constructor({ onStateChange } = {}) {
    this.onStateChange = onStateChange;
    this.workers = [];
    this.pendingLoads = new Map();
    this.pendingQueries = new Map();
    this.nextQueryId = 0;
    this.activeQueryId = 0;
    this.state = {
      phase: "idle",
      summary: "No dataset loaded yet.",
      coordinator: {
        phase: "idle",
        detail: "Waiting for dataset",
      },
      workers: [],
    };
    this._emitState();
  }

  async dispose() {
    const disposedError = new Error("Query worker pool disposed");
    for (const [workerId, pending] of this.pendingLoads) {
      pending.reject(disposedError);
      this.pendingLoads.delete(workerId);
    }
    for (const [, pendingByWorker] of this.pendingQueries) {
      for (const [workerId, pending] of pendingByWorker) {
        pending.reject(disposedError);
        pendingByWorker.delete(workerId);
      }
    }
    this.pendingQueries.clear();

    for (const entry of this.workers) {
      entry.worker.terminate();
    }
    this.workers = [];
    this.state = {
      phase: "idle",
      summary: "No dataset loaded yet.",
      coordinator: {
        phase: "idle",
        detail: "Waiting for dataset",
      },
      workers: [],
    };
    this._emitState();
  }

  async loadSeriesData(seriesData) {
    await this.dispose();

    const workerCount = chooseWorkerCount(seriesData.length);
    const partitions = Array.from({ length: workerCount }, () => []);
    for (let i = 0; i < seriesData.length; i++) {
      partitions[i % workerCount].push(seriesData[i]);
    }

    this.state = {
      phase: "loading",
      summary: `Provisioning ${workerCount} query workers…`,
      coordinator: {
        phase: "loading",
        detail: `Sharding ${seriesData.length.toLocaleString()} series`,
      },
      workers: partitions.map((partition, idx) => ({
        id: idx,
        name: `query-${String(idx + 1).padStart(2, "0")}`,
        role: idx === 0 ? "hot-owner" : "history-shard",
        phase: "loading",
        detail: `Receiving ${partition.length.toLocaleString()} series`,
        seriesCount: 0,
        sampleCount: 0,
        task: "Booting worker",
        durationMs: 0,
        scannedSeries: 0,
        scannedSamples: 0,
        resultSeries: 0,
      })),
    };
    this._emitState();

    const loadPromises = partitions.map((partition, idx) => {
      const worker = new Worker(new URL("./query-worker.js", import.meta.url), { type: "module" });
      const entry = { id: idx, worker };
      this.workers.push(entry);

      worker.addEventListener("message", (event) => this._handleMessage(event.data));
      worker.addEventListener("error", (event) => {
        console.error("query worker error", event);
        const workerError = new Error(`Query worker ${idx + 1} failed`);
        const pendingLoad = this.pendingLoads.get(idx);
        if (pendingLoad) {
          this.pendingLoads.delete(idx);
          pendingLoad.reject(workerError);
        }
        for (const [queryId, pendingByWorker] of this.pendingQueries) {
          const pending = pendingByWorker.get(idx);
          if (!pending) continue;
          pendingByWorker.delete(idx);
          pending.reject(workerError);
          if (pendingByWorker.size === 0) this.pendingQueries.delete(queryId);
        }
        this.state.phase = "fallback";
        this.state.summary = `Worker ${idx + 1} failed; coordinator fallback required`;
        this.state.coordinator = {
          phase: "fallback",
          detail: workerError.message,
        };
        this.state.workers = this.state.workers.map((stateWorker) =>
          stateWorker.id === idx
            ? {
                ...stateWorker,
                phase: "fallback",
                task: "Worker fault",
                detail: workerError.message,
              }
            : stateWorker
        );
        this._emitState();
      });

      const payload = partition.map((series) => ({
        labels: [...series.labels.entries()],
        timestamps: series.timestamps,
        values: series.values,
      }));
      const transfer = [];
      for (const series of payload) {
        transfer.push(series.timestamps.buffer, series.values.buffer);
      }

      return new Promise((resolve, reject) => {
        this.pendingLoads.set(idx, { resolve, reject });
        worker.postMessage(
          {
            type: "load-partition",
            workerId: idx,
            series: payload,
          },
          transfer
        );
      });
    });

    await Promise.all(loadPromises);

    const totalSamples = this.state.workers.reduce((sum, worker) => sum + worker.sampleCount, 0);
    this.state.phase = "ready";
    this.state.summary = `${workerCount} query workers ready across ${totalSamples.toLocaleString()} raw samples`;
    this.state.coordinator = {
      phase: "ready",
      detail: "Coordinator standing by",
    };
    this.state.workers = this.state.workers.map((worker) => ({
      ...worker,
      phase: "ready",
      detail: `${worker.seriesCount.toLocaleString()} series resident`,
      task: "Idle",
    }));
    this._emitState();
  }

  async query(opts) {
    const queryId = ++this.nextQueryId;
    this.activeQueryId = queryId;

    this.state.phase = "running";
    this.state.summary = `Dispatching ${opts.metric} to ${this.workers.length} workers`;
    this.state.coordinator = {
      phase: "running",
      detail: `Fan-out started for query #${queryId}`,
    };
    this.state.workers = this.state.workers.map((worker) => ({
      ...worker,
      phase: "running",
      task: opts.metric,
      detail: opts.agg ? `${opts.agg} aggregation` : "Raw scan",
      durationMs: 0,
      scannedSeries: 0,
      scannedSamples: 0,
      resultSeries: 0,
    }));
    this._emitState();

    const responses = await Promise.all(
      this.workers.map((entry) => {
        return new Promise((resolve, reject) => {
          if (!this.pendingQueries.has(queryId)) this.pendingQueries.set(queryId, new Map());
          this.pendingQueries.get(queryId).set(entry.id, { resolve, reject });
          entry.worker.postMessage({
            type: "query",
            queryId,
            workerId: entry.id,
            opts,
          });
        });
      })
    );

    if (queryId === this.activeQueryId) {
      this.state.phase = "complete";
      this.state.summary = `${this.workers.length} workers finished query #${queryId}`;
      this.state.coordinator = {
        phase: "complete",
        detail: `Ready to merge ${responses.length} partials`,
      };
      this._emitState();
    }

    return responses;
  }

  markMerged(queryId, detail) {
    if (queryId !== this.activeQueryId) return;
    this.state.phase = "complete";
    this.state.summary = detail;
    this.state.coordinator = {
      phase: "complete",
      detail,
    };
    this._emitState();
  }

  markFallback(detail) {
    this.state.phase = "fallback";
    this.state.summary = detail;
    this.state.coordinator = {
      phase: "fallback",
      detail,
    };
    this.state.workers = this.state.workers.map((worker) => ({
      ...worker,
      phase: "ready",
      task: "Idle",
      detail: `${worker.seriesCount.toLocaleString()} series resident`,
    }));
    this._emitState();
  }

  _handleMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "load-ack") {
      const pending = this.pendingLoads.get(message.workerId);
      if (!pending) return;
      this.pendingLoads.delete(message.workerId);
      this.state.workers = this.state.workers.map((worker) =>
        worker.id === message.workerId
          ? {
              ...worker,
              phase: "ready",
              detail: `${message.sampleCount.toLocaleString()} raw samples`,
              task: "Idle",
              seriesCount: message.seriesCount,
              sampleCount: message.sampleCount,
            }
          : worker
      );
      this._emitState();
      pending.resolve(message);
      return;
    }

    if (message.type === "query-result") {
      const pendingByWorker = this.pendingQueries.get(message.queryId);
      const pending = pendingByWorker?.get(message.workerId);
      if (!pending) return;
      pendingByWorker.delete(message.workerId);
      if (pendingByWorker.size === 0) this.pendingQueries.delete(message.queryId);

      if (message.queryId === this.activeQueryId) {
        const baseResult = message.kind === "avg" ? message.sum : message.result;
        this.state.workers = this.state.workers.map((worker) =>
          worker.id === message.workerId
            ? {
                ...worker,
                phase: "complete",
                task: `Query #${message.queryId}`,
                detail: `${baseResult.series.length.toLocaleString()} partial series`,
                durationMs: message.durationMs,
                scannedSeries: baseResult.scannedSeries,
                scannedSamples: baseResult.scannedSamples,
                resultSeries: baseResult.series.length,
              }
            : worker
        );
        this._emitState();
      }

      pending.resolve(message);
    }
  }

  _emitState() {
    this.onStateChange?.(structuredClone(this.state));
  }
}
