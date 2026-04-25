import { buildWorkerPartitionPayload } from "./query-worker-store.js";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeHardwareConcurrency() {
  return typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
}

export function detectExecutionCapabilities() {
  return {
    workers: typeof Worker !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === "boolean" ? globalThis.crossOriginIsolated : false,
    hardwareConcurrency: safeHardwareConcurrency(),
  };
}

function normalizeRequestedWorkers(requestedWorkers, hardwareConcurrency) {
  if (requestedWorkers === "auto" || requestedWorkers == null) {
    return clamp(Math.max(1, Math.floor(hardwareConcurrency / 2)), 1, 4);
  }
  const parsed = typeof requestedWorkers === "number" ? requestedWorkers : Number(requestedWorkers);
  if (!Number.isFinite(parsed)) {
    return clamp(Math.max(1, Math.floor(hardwareConcurrency / 2)), 1, 4);
  }
  return clamp(Math.floor(parsed), 0, Math.max(1, hardwareConcurrency));
}

function topologyFromWorkerCount(workerCount) {
  if (workerCount <= 0) return "inline";
  if (workerCount === 1) return "single-worker";
  if (workerCount === 2) return "split";
  return "pooled";
}

function transportFromCapabilities(capabilities) {
  if (!capabilities.workers) return "inline";
  return capabilities.sharedArrayBuffer && capabilities.crossOriginIsolated
    ? "shared-frozen"
    : "transfer";
}

function planReason(capabilities, actualWorkers, transport) {
  if (!capabilities.workers) return "Workers unavailable in this runtime.";
  if (actualWorkers === 0) return "Worker count resolved to 0, using inline execution.";
  if (transport === "shared-frozen") {
    return "Cross-origin isolation is active, so frozen chunks can use SharedArrayBuffer.";
  }
  if (capabilities.sharedArrayBuffer && !capabilities.crossOriginIsolated) {
    return "SharedArrayBuffer exists, but this runtime is not cross-origin isolated, so transferables are used.";
  }
  return "SharedArrayBuffer is unavailable here, so workers use transferable chunk snapshots.";
}

export function deriveTopologyPlan({
  seriesCount = 0,
  requestedWorkers = "auto",
  capabilities = detectExecutionCapabilities(),
} = {}) {
  const normalizedWorkers = normalizeRequestedWorkers(
    requestedWorkers,
    capabilities.hardwareConcurrency
  );
  // Small workloads do not amortize worker startup and merge overhead well, so
  // cap series counts below 16 to a single worker even when auto-sizing higher.
  const actualWorkers = capabilities.workers
    ? seriesCount > 0 && seriesCount < 16
      ? Math.min(normalizedWorkers, 1)
      : normalizedWorkers
    : 0;
  const topology = topologyFromWorkerCount(actualWorkers);
  const transport = actualWorkers > 0 ? transportFromCapabilities(capabilities) : "inline";
  return {
    requestedWorkers,
    actualWorkers,
    topology,
    transport,
    capabilities,
    reason: planReason(capabilities, actualWorkers, transport),
  };
}

export function supportsParallelQuery(opts) {
  return !["last", "p50", "p95", "p99"].includes(opts.agg || "");
}

function workerRoleForPlan(plan, index) {
  if (plan.topology === "single-worker") return "combined-engine";
  if (index === 0) return "primary-engine";
  return "query-shard";
}

export class QueryWorkerPool {
  constructor({ onStateChange, workers = "auto" } = {}) {
    this.onStateChange = onStateChange;
    this.requestedWorkers = workers;
    this.workers = [];
    this.pendingLoads = new Map();
    this.pendingQueries = new Map();
    this.loadPromise = null;
    this.nextQueryId = 0;
    this.activeQueryId = 0;
    this.state = {
      phase: "idle",
      summary: "No dataset loaded yet.",
      coordinator: {
        phase: "idle",
        detail: "Waiting for dataset",
        stats: null,
      },
      plan: null,
      workers: [],
    };
    this._emitState();
  }

  async dispose(preserveLoadPromise = false) {
    const disposedError = new Error("Query worker pool disposed");
    // loadStore() keeps awaiting this.loadPromise while it tears down and rebuilds
    // the pool, so internal dispose() calls must preserve the promise reference.
    if (!preserveLoadPromise) this.loadPromise = null;
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
        stats: null,
      },
      plan: null,
      workers: [],
    };
    this._emitState();
  }

  async loadStore(store) {
    const loadPromise = (async () => {
      await this.dispose(true);

      const seriesCount = store.seriesCount || 0;
      const plan = deriveTopologyPlan({
        seriesCount,
        requestedWorkers: this.requestedWorkers,
      });
      const workerCount = plan.actualWorkers;

      if (workerCount <= 0) {
        this.state = {
          phase: "fallback",
          summary: "Inline engine selected for this runtime.",
          coordinator: {
            phase: "fallback",
            detail: plan.reason,
            stats: null,
          },
          plan,
          workers: [],
        };
        this._emitState();
        return;
      }

      const partitionIds = Array.from({ length: workerCount }, () => []);
      for (let i = 0; i < seriesCount; i++) {
        partitionIds[i % workerCount].push(i);
      }

      this.state = {
        phase: "loading",
        summary: `Provisioning ${workerCount} query workers in ${plan.topology} mode…`,
        coordinator: {
          phase: "loading",
          detail: `Sharding ${seriesCount.toLocaleString()} series. ${plan.reason}`,
          stats: null,
        },
        plan,
        workers: partitionIds.map((ids, idx) => ({
          id: idx,
          name: `query-${String(idx + 1).padStart(2, "0")}`,
          role: workerRoleForPlan(plan, idx),
          phase: "loading",
          detail: `Receiving ${ids.length.toLocaleString()} series`,
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

      const loadPromises = partitionIds.map((ids, idx) => {
        const worker = new Worker(new URL("./query-worker.js", import.meta.url), {
          type: "module",
        });
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
            stats: null,
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

        const payload = buildWorkerPartitionPayload(store, ids);

        return new Promise((resolve, reject) => {
          this.pendingLoads.set(idx, { resolve, reject });
          worker.postMessage(
            {
              type: "load-partition",
              workerId: idx,
              kind: payload.kind,
              series: payload.series,
            },
            payload.transfer
          );
        });
      });

      try {
        await Promise.all(loadPromises);
      } catch (error) {
        // Worker error handling already moved the pool into fallback mode; avoid
        // rethrowing the same failure through loadStore() when inline fallback is
        // now the intended execution path.
        if (this.state.phase === "fallback") return;
        throw error;
      }
      const totalSamples = this.state.workers.reduce((sum, worker) => sum + worker.sampleCount, 0);
      this.state.phase = "ready";
      this.state.summary = `${workerCount} query workers ready in ${plan.topology} mode across ${totalSamples.toLocaleString()} raw samples`;
      this.state.coordinator = {
        phase: "ready",
        detail: plan.reason,
        stats: null,
      };
      this.state.workers = this.state.workers.map((worker) => ({
        ...worker,
        phase: "ready",
        detail: `${worker.seriesCount.toLocaleString()} series resident`,
        task: "Idle",
      }));
      this._emitState();
    })();
    this.loadPromise = loadPromise;
    await loadPromise;
  }

  async query(opts) {
    if ((this.state.phase === "idle" || this.state.phase === "loading") && this.loadPromise) {
      await this.loadPromise;
    }

    if (this.state.phase !== "ready" && this.state.phase !== "complete") {
      throw new Error("Query worker pool is not ready");
    }

    const queryId = ++this.nextQueryId;
    this.activeQueryId = queryId;

    this.state.phase = "running";
    this.state.summary = `Dispatching ${opts.metric} to ${this.workers.length} workers`;
    this.state.coordinator = {
      phase: "running",
      detail: `Fan-out started for query #${queryId}`,
      stats: null,
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
        stats: null,
      };
      this._emitState();
    }

    return responses;
  }

  async broadcastLiveAppend(store, appendsBySeriesId) {
    if (
      this.state.phase !== "ready" &&
      this.state.phase !== "complete" &&
      this.state.phase !== "running"
    )
      return;
    if (this.workers.length === 0) return;

    const workerCount = this.workers.length;
    const workerAppends = Array.from({ length: workerCount }, () => []);

    for (const [seriesId, data] of appendsBySeriesId.entries()) {
      const workerIdx = seriesId % workerCount;
      const partitionId = Math.floor(seriesId / workerCount);

      // If this is a new series the worker doesn't know about yet, send metadata
      const labels = store.labels(seriesId);

      workerAppends[workerIdx].push({
        partitionId,
        labels: labels ? [...labels.entries()] : null,
        timestamps: data.timestamps,
        values: data.values,
      });
    }

    for (let i = 0; i < workerCount; i++) {
      const appends = workerAppends[i];
      if (appends.length === 0) continue;
      this.workers[i].worker.postMessage({
        type: "append-live",
        workerId: i,
        appends,
      });
    }
  }

  markMerged(queryId, detail, stats = null) {
    if (queryId !== this.activeQueryId) return;
    this.state.phase = "complete";
    this.state.summary = detail;
    this.state.coordinator = {
      phase: "complete",
      detail,
      stats,
    };
    this._emitState();
  }

  markComplete(detail, stats = null) {
    this.state.phase = "complete";
    this.state.summary = detail;
    this.state.coordinator = {
      phase: "complete",
      detail,
      stats,
    };
    this._emitState();
  }

  markFallback(detail) {
    this.state.phase = "fallback";
    this.state.summary = detail;
    this.state.coordinator = {
      phase: "fallback",
      detail,
      stats: null,
    };
    this.state.workers = this.state.workers.map((worker) => ({
      ...worker,
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

    if (message.type === "append-ack") {
      this.state.workers = this.state.workers.map((worker) =>
        worker.id === message.workerId
          ? {
              ...worker,
              sampleCount: message.sampleCount,
            }
          : worker
      );
      this._emitState();
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
