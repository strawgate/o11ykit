import { ColumnStore } from "./column-store.js";
import { ScanEngine } from "./query.js";
import type { QueryEngine, StorageBackend, ValuesCodec } from "./types.js";
import type { WasmCodecs } from "./wasm-codecs.js";
import { initWasmCodecs } from "./wasm-codecs.js";
import { err, ok, type RequestEnvelope, type ResponseEnvelope } from "./worker-protocol.js";

interface WorkerLikeEndpoint {
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
  addEventListener?: (type: "message", listener: (event: { data: unknown }) => void) => void;
  on?: (type: "message", listener: (data: unknown) => void) => void;
}

function createValuesCodec(): ValuesCodec {
  return {
    name: "f64-plain",
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
      const values = new Float64Array(
        copy.buffer,
        copy.byteOffset,
        Math.min(n, Math.floor(bytes / 8))
      );
      return values.slice();
    },
  };
}

/**
 * Try to load the WASM binary from the co-located wasm/ directory.
 * Returns null if WASM is not available (browser without fetch, missing binary, etc).
 */
async function tryLoadWasm(): Promise<WasmCodecs | null> {
  try {
    const dynamicImport = new Function("s", "return import(s)") as (
      specifier: string
    ) => Promise<any>;
    const nodeFs = await dynamicImport("node:fs").catch(() => null);
    const nodePath = await dynamicImport("node:path").catch(() => null);
    const nodeUrl = await dynamicImport("node:url").catch(() => null);

    if (nodeFs && nodePath && nodeUrl) {
      const thisDir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
      const wasmPath = nodePath.join(thisDir, "..", "wasm", "o11ytsdb-rust.wasm");
      if (nodeFs.existsSync(wasmPath)) {
        const bytes = nodeFs.readFileSync(wasmPath);
        const module = new WebAssembly.Module(bytes);
        return initWasmCodecs(module);
      }
    }
  } catch {
    // Fall through to plain codec.
  }

  try {
    if (typeof fetch === "function") {
      const resp = await fetch(new URL("../wasm/o11ytsdb-rust.wasm", import.meta.url));
      if (resp.ok) {
        const module = await WebAssembly.compileStreaming(resp);
        return initWasmCodecs(module);
      }
    }
  } catch {
    // Fall through to plain codec.
  }

  return null;
}

function resolveEndpoint(): WorkerLikeEndpoint {
  const maybeSelf = globalThis as {
    self?: WorkerLikeEndpoint;
    postMessage?: (message: unknown, transfer?: ArrayBufferLike[]) => void;
  };

  if (maybeSelf.self && typeof maybeSelf.self.postMessage === "function") {
    return maybeSelf.self;
  }

  if (typeof maybeSelf.postMessage === "function") {
    return {
      postMessage: maybeSelf.postMessage.bind(globalThis),
      addEventListener: (type, listener) => {
        (
          globalThis as unknown as {
            addEventListener: (event: string, cb: (e: { data: unknown }) => void) => void;
          }
        ).addEventListener(type, listener);
      },
    };
  }

  throw new Error("No worker endpoint available.");
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
  private createStore: (chunkSize: number) => StorageBackend;
  private store: StorageBackend;
  private wasmCodecs: WasmCodecs | null = null;
  private wasmReady: Promise<void>;

  constructor(endpoint?: WorkerLikeEndpoint, config?: WorkerRuntimeConfig) {
    this.endpoint = endpoint ?? resolveEndpoint();
    const codec = createValuesCodec();
    this.createStore = config?.createStore ?? ((cs: number) => new ColumnStore(codec, cs));
    this.engine = config?.queryEngine ?? new ScanEngine();
    this.store = this.createStore(1024);

    // Load WASM codecs in the background.
    this.wasmReady = tryLoadWasm()
      .then((wc) => {
        if (wc) {
          this.wasmCodecs = wc;
          this.createStore = (cs: number) =>
            new ColumnStore(wc.valuesCodec, cs, undefined, undefined, wc.tsCodec, wc.rangeCodec);
          this.store = this.createStore(1024);
        }
      })
      .catch(() => {
        /* WASM not available — continue with plain codec */
      });
  }

  start(): void {
    const listener = (raw: unknown): void => {
      const eventData = (raw as { data?: unknown }).data ?? raw;
      if (!eventData || typeof eventData !== "object") return;

      const msg = eventData as RequestEnvelope;
      if (msg.kind !== "request") return;
      void this.handle(msg);
    };

    if (typeof this.endpoint.addEventListener === "function") {
      this.endpoint.addEventListener("message", listener);
      return;
    }

    if (typeof this.endpoint.on === "function") {
      this.endpoint.on("message", listener);
      return;
    }

    throw new Error("Worker endpoint does not support message listeners.");
  }

  private async handle(msg: RequestEnvelope): Promise<void> {
    const { id, payload, meta } = msg;
    try {
      switch (payload.type) {
        case "init": {
          // Ensure WASM codecs are loaded before re-creating the store.
          await this.wasmReady;
          const chunkSize = payload.chunkSize ?? 1024;
          this.store = this.createStore(chunkSize);
          this.send(ok(id, { ok: true, type: "init", backend: this.store.name }, meta));
          return;
        }
        case "ingest": {
          const labels = new Map(payload.labels);
          const seriesId = this.store.getOrCreateSeries(labels);
          this.store.appendBatch(seriesId, payload.timestamps, payload.values);
          this.send(
            ok(
              id,
              { ok: true, type: "ingest", seriesId, ingestedSamples: payload.values.length },
              meta
            )
          );
          return;
        }
        case "query": {
          const result = this.engine.query(this.store, payload.opts);
          this.send(ok(id, { ok: true, type: "query", result }, meta));
          return;
        }
        case "stats": {
          this.send(
            ok(
              id,
              {
                ok: true,
                type: "stats",
                stats: {
                  seriesCount: this.store.seriesCount,
                  sampleCount: this.store.sampleCount,
                  memoryBytes: this.store.memoryBytes(),
                },
              },
              meta
            )
          );
          return;
        }
        case "echo": {
          this.send(ok(id, { ok: true, type: "echo", bytes: payload.payload.byteLength }, meta));
          return;
        }
        case "close": {
          this.send(ok(id, { ok: true, type: "close" }, meta));
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
if (endpointProbe.self || typeof endpointProbe.onmessage !== "undefined") {
  new O11yWorkerRuntime().start();
} else {
  const dynamicImport = new Function("s", "return import(s)") as (
    specifier: string
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import requires any
  ) => Promise<any>;
  void dynamicImport("node:worker_threads")
    .then((wt) => {
      if (!wt.parentPort) return;
      const endpoint: WorkerLikeEndpoint = {
        postMessage: (message, transfer) => wt.parentPort.postMessage(message, transfer),
        on: (type, listener) => {
          if (type !== "message") return;
          wt.parentPort.on("message", (data: unknown) => listener({ data }));
        },
      };
      new O11yWorkerRuntime(endpoint).start();
    })
    .catch(() => {
      // Browser-like runtime without node worker_threads.
    });
}
