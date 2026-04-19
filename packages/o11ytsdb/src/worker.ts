import { ColumnStore } from './column-store.js';
import { ingestOtlpJson } from './ingest.js';
import { ScanEngine } from './query.js';
import type { QueryEngine, StorageBackend, ValuesCodec } from './types.js';
import {
  err,
  ok,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './worker-protocol.js';

interface WorkerLikeEndpoint {
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
  addEventListener?: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  on?: (type: 'message', listener: (data: unknown) => void) => void;
}

function decodeUtf8(payload: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(payload).toString('utf8');
  }
  const decoderCtor = (globalThis as { TextDecoder?: new () => { decode: (input: Uint8Array) => string } }).TextDecoder;
  if (decoderCtor) return new decoderCtor().decode(payload);

  let encoded = '';
  for (let i = 0; i < payload.length; i++) encoded += String.fromCharCode(payload[i]!);
  return decodeURIComponent(escape(encoded));
}

function createValuesCodec(): ValuesCodec {
  return {
    name: 'f64-plain',
    encodeValues(values: Float64Array): Uint8Array {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf: Uint8Array): Float64Array {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      const values = new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
      return values.slice();
    },
  };
}

function resolveEndpoint(): WorkerLikeEndpoint {
  const maybeSelf = globalThis as {
    self?: WorkerLikeEndpoint;
    postMessage?: (message: unknown, transfer?: ArrayBufferLike[]) => void;
  };

  if (maybeSelf.self && typeof maybeSelf.self.postMessage === 'function') {
    return maybeSelf.self;
  }

  if (typeof maybeSelf.postMessage === 'function') {
    return {
      postMessage: maybeSelf.postMessage.bind(globalThis),
      addEventListener: (type, listener) => {
        (globalThis as unknown as { addEventListener: (event: string, cb: (e: { data: unknown }) => void) => void })
          .addEventListener(type, listener);
      },
    };
  }

  throw new Error('No worker endpoint available.');
}

export interface WorkerRuntimeConfig {
  /** Factory to create a storage backend. Receives the chunk size from the init message. */
  createStore?: (chunkSize: number) => StorageBackend;
  /** Query engine instance. Defaults to ScanEngine. */
  queryEngine?: QueryEngine;
}

export class O11yWorkerRuntime {
  private readonly endpoint: WorkerLikeEndpoint;
  private readonly engine: QueryEngine;
  private readonly createStore: (chunkSize: number) => StorageBackend;
  private store: StorageBackend;
  constructor(endpoint?: WorkerLikeEndpoint, config?: WorkerRuntimeConfig) {
    this.endpoint = endpoint ?? resolveEndpoint();
    const codec = createValuesCodec();
    this.createStore = config?.createStore ?? ((cs: number) => new ColumnStore(codec, cs));
    this.engine = config?.queryEngine ?? new ScanEngine();
    this.store = this.createStore(1024);
  }

  start(): void {
    const listener = (raw: unknown): void => {
      const eventData = (raw as { data?: unknown }).data ?? raw;
      if (!eventData || typeof eventData !== 'object') return;

      const msg = eventData as RequestEnvelope;
      if (msg.kind !== 'request') return;
      void this.handle(msg);
    };

    if (typeof this.endpoint.addEventListener === 'function') {
      this.endpoint.addEventListener('message', listener);
      return;
    }

    if (typeof this.endpoint.on === 'function') {
      this.endpoint.on('message', listener);
      return;
    }

    throw new Error('Worker endpoint does not support message listeners.');
  }

  private async handle(msg: RequestEnvelope): Promise<void> {
    const { id, payload, meta } = msg;
    try {
      switch (payload.type) {
        case 'init': {
          const chunkSize = payload.chunkSize ?? 1024;
          this.store = this.createStore(chunkSize);
          this.send(ok(id, { ok: true, type: 'init', backend: this.store.name }, meta));
          return;
        }
        case 'ingest': {
          const jsonPayload = decodeUtf8(payload.payload);
          const result = ingestOtlpJson(jsonPayload, this.store);
          this.send(ok(id, { ok: true, type: 'ingest', result }, meta));
          return;
        }
        case 'append': {
          const labels = new Map(payload.labels);
          const seriesId = this.store.getOrCreateSeries(labels);
          this.store.appendBatch(seriesId, payload.timestamps, payload.values);
          this.send(ok(id, { ok: true, type: 'append', seriesId, ingestedSamples: payload.values.length }, meta));
          return;
        }
        case 'query': {
          const result = this.engine.query(this.store, payload.opts);
          this.send(ok(id, { ok: true, type: 'query', result }, meta));
          return;
        }
        case 'stats': {
          this.send(ok(id, {
            ok: true,
            type: 'stats',
            stats: {
              seriesCount: this.store.seriesCount,
              sampleCount: this.store.sampleCount,
              memoryBytes: this.store.memoryBytes(),
            },
          }, meta));
          return;
        }
        case 'echo': {
          this.send(ok(id, { ok: true, type: 'echo', bytes: payload.payload.byteLength }, meta));
          return;
        }
        case 'close': {
          this.send(ok(id, { ok: true, type: 'close' }, meta));
          return;
        }
      }
    } catch (error) {
      this.send(err(id, error, meta));
    }
  }

  private send(message: ResponseEnvelope): void {
    this.endpoint.postMessage(message);
  }
}

const endpointProbe = globalThis as { self?: unknown; onmessage?: unknown };
if (endpointProbe.self || typeof endpointProbe.onmessage !== 'undefined') {
  new O11yWorkerRuntime().start();
} else {
  const dynamicImport = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;
  void dynamicImport('node:worker_threads')
    .then((wt) => {
      if (!wt.parentPort) return;
      const endpoint: WorkerLikeEndpoint = {
        postMessage: (message, transfer) => wt.parentPort.postMessage(message, transfer),
        on: (type, listener) => {
          if (type !== 'message') return;
          wt.parentPort.on('message', (data: unknown) => listener({ data }));
        },
      };
      new O11yWorkerRuntime(endpoint).start();
    })
    .catch(() => {
      // Browser-like runtime without node worker_threads.
    });
}
