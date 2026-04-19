import type { IngestResult } from './ingest.js';
import type { QueryOpts, QueryResult } from './types.js';
import {
  isResponseEnvelope,
  type RequestEnvelope,
  type RequestId,
  type ResponseEnvelope,
  type TransferStrategy,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol.js';

interface MessageEventLike {
  data: unknown;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  terminate?: () => void;
}

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
}

function encodeUtf8(value: string): Uint8Array {
  const nodeBuffer = (globalThis as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } }).Buffer;
  if (nodeBuffer) {
    return Uint8Array.from(nodeBuffer.from(value, 'utf8'));
  }
  const encoded = unescape(encodeURIComponent(value));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i);
  return out;
}

export interface WorkerClientOptions {
  worker: WorkerLike;
  transferStrategy?: TransferStrategy;
}

export class WorkerClient {
  private readonly worker: WorkerLike;
  private readonly transferStrategy: TransferStrategy;
  private nextId: RequestId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();

  constructor(opts: WorkerClientOptions) {
    this.worker = opts.worker;
    this.transferStrategy = opts.transferStrategy ?? 'transferable';
    this.worker.addEventListener('message', (event) => this.onMessage(event.data));
  }

  async init(chunkSize?: number): Promise<{ backend: string }> {
    const payload: WorkerRequest = chunkSize === undefined
      ? { type: 'init' }
      : { type: 'init', chunkSize };

    const response = await this.send(payload);
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'init') throw new Error(`Unexpected response type: ${response.type}`);
    return { backend: response.backend };
  }

  async ingest(
    payload: string,
    strategy: TransferStrategy = this.transferStrategy,
  ): Promise<IngestResult> {
    const encoded = encodeUtf8(payload);
    const transferables = strategy === 'transferable' ? [encoded.buffer] : [];

    const response = await this.send({
      type: 'ingest',
      payload: encoded,
    }, transferables, strategy);

    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'ingest') throw new Error(`Unexpected response type: ${response.type}`);
    return response.result;
  }

  async append(
    labels: ReadonlyMap<string, string>,
    timestamps: BigInt64Array,
    values: Float64Array,
  ): Promise<{ seriesId: number; ingestedSamples: number }> {
    const response = await this.send({
      type: 'append',
      labels: [...labels.entries()],
      timestamps,
      values,
    }, this.getTransferables(timestamps, values));

    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'append') throw new Error(`Unexpected response type: ${response.type}`);
    return { seriesId: response.seriesId, ingestedSamples: response.ingestedSamples };
  }

  async query(opts: QueryOpts): Promise<QueryResult> {
    const response = await this.send({ type: 'query', opts });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'query') throw new Error(`Unexpected response type: ${response.type}`);
    return response.result;
  }

  async stats(): Promise<{ seriesCount: number; sampleCount: number; memoryBytes: number }> {
    const response = await this.send({ type: 'stats' });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'stats') throw new Error(`Unexpected response type: ${response.type}`);
    return response.stats;
  }

  async echo(payload: Uint8Array, strategy: TransferStrategy = this.transferStrategy): Promise<number> {
    const transferables = strategy === 'transferable' ? [payload.buffer] : [];
    const response = await this.send({ type: 'echo', payload }, transferables, strategy);
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'echo') throw new Error(`Unexpected response type: ${response.type}`);
    return response.bytes;
  }

  async close(): Promise<void> {
    const response = await this.send({ type: 'close' });
    if (response.ok === false) throw new Error(response.error);
    if (response.type !== 'close') throw new Error(`Unexpected response type: ${response.type}`);
    this.worker.terminate?.();
  }

  private send<T extends WorkerRequest>(
    payload: T,
    transfer: ArrayBufferLike[] = [],
    strategy: TransferStrategy = this.transferStrategy,
  ): Promise<WorkerResponse> {
    const id = this.nextId++;
    const envelope: RequestEnvelope<T> = {
      id,
      kind: 'request',
      payload,
      meta: { strategy, sentAt: Date.now() },
    };

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(envelope, transfer);
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

  private getTransferables(timestamps: BigInt64Array, values: Float64Array): ArrayBufferLike[] {
    if (this.transferStrategy !== 'transferable') return [];
    return [timestamps.buffer, values.buffer];
  }
}
