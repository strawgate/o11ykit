import { BackpressureController } from "./backpressure.js";
import type { QueryOpts, QueryResult } from "./types.js";
import {
  isResponseEnvelope,
  type RequestEnvelope,
  type RequestId,
  type ResponseEnvelope,
  type TransferStrategy,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";

interface MessageEventLike {
  data: unknown;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  terminate?: () => void;
}

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
}

export interface WorkerClientOptions {
  worker: WorkerLike;
  transferStrategy?: TransferStrategy;
  /** Max concurrent in-flight ingest requests. Defaults to 64. */
  maxInflightIngest?: number;
}

export class WorkerClient {
  private readonly worker: WorkerLike;
  private readonly transferStrategy: TransferStrategy;
  private nextId: RequestId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly ingestSemaphore: BackpressureController;

  private closed = false;

  constructor(opts: WorkerClientOptions) {
    this.worker = opts.worker;
    this.transferStrategy = opts.transferStrategy ?? "transferable";
    this.ingestSemaphore = new BackpressureController(opts.maxInflightIngest ?? 64);
    this.worker.addEventListener("message", (event) => this.onMessage(event.data));
    this.worker.addEventListener("error", (event) => this.onError(event));
  }

  /** Snapshot of ingest backpressure state. */
  get ingestBackpressure(): {
    pending: number;
    waiting: number;
    maxConcurrency: number;
  } {
    return {
      pending: this.ingestSemaphore.pending,
      waiting: this.ingestSemaphore.waiting,
      maxConcurrency: this.ingestSemaphore.maxConcurrency,
    };
  }

  async init(opts?: { chunkSize?: number; precision?: number }): Promise<{ backend: string }> {
    const payload: WorkerRequest = { type: "init", ...opts };

    const response = await this.send(payload);
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== "init") throw new Error(`Unexpected response type: ${response.type}`);
    return { backend: response.backend };
  }

  async ingest(
    labels: ReadonlyMap<string, string>,
    timestamps: BigInt64Array,
    values: Float64Array
  ): Promise<{ seriesId: number; ingestedSamples: number }> {
    await this.ingestSemaphore.acquire();
    try {
      const response = await this.send(
        {
          type: "ingest",
          labels: [...labels.entries()],
          timestamps,
          values,
        },
        this.getTransferables(timestamps, values)
      );

      if (response.ok === false) throw new Error(response.error);
      if (response.type !== "ingest") throw new Error(`Unexpected response type: ${response.type}`);
      return { seriesId: response.seriesId, ingestedSamples: response.ingestedSamples };
    } finally {
      this.ingestSemaphore.release();
    }
  }

  async query(opts: QueryOpts): Promise<QueryResult> {
    const response = await this.send({ type: "query", opts });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== "query") throw new Error(`Unexpected response type: ${response.type}`);
    return response.result;
  }

  async stats(): Promise<{ seriesCount: number; sampleCount: number; memoryBytes: number }> {
    const response = await this.send({ type: "stats" });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== "stats") throw new Error(`Unexpected response type: ${response.type}`);
    return response.stats;
  }

  async echo(
    payload: Uint8Array,
    strategy: TransferStrategy = this.transferStrategy
  ): Promise<number> {
    const transferables = strategy === "transferable" ? [payload.buffer] : [];
    const response = await this.send({ type: "echo", payload }, transferables, strategy);
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== "echo") throw new Error(`Unexpected response type: ${response.type}`);
    return response.bytes;
  }

  async close(): Promise<void> {
    const response = await this.send({ type: "close" });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== "close") throw new Error(`Unexpected response type: ${response.type}`);
    this.closed = true;
    this.ingestSemaphore.dispose();
    this.worker.terminate?.();
    this.rejectAllPending(new Error("WorkerClient closed"));
  }

  private send<T extends WorkerRequest>(
    payload: T,
    transfer: ArrayBufferLike[] = [],
    strategy: TransferStrategy = this.transferStrategy
  ): Promise<WorkerResponse> {
    if (this.closed) {
      return Promise.reject(new Error("WorkerClient is closed"));
    }
    const id = this.nextId++;
    const envelope: RequestEnvelope<T> = {
      id,
      kind: "request",
      payload,
      meta: { strategy, sentAt: Date.now() },
    };

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(envelope, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private onMessage(raw: unknown): void {
    if (!isResponseEnvelope(raw)) return;
    const response = raw as ResponseEnvelope;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.payload.ok === false) {
      pending.reject(new Error(response.payload.error));
      return;
    }
    pending.resolve(response.payload);
  }

  private onError(event: unknown): void {
    const message =
      event && typeof event === "object" && "message" in event
        ? String((event as { message: unknown }).message)
        : "Worker error";
    this.closed = true;
    this.rejectAllPending(new Error(message));
  }

  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) p.reject(error);
  }

  private getTransferables(timestamps: BigInt64Array, values: Float64Array): ArrayBufferLike[] {
    if (this.transferStrategy !== "transferable") return [];
    return [timestamps.buffer, values.buffer];
  }
}
