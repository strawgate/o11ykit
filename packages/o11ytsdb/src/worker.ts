import { ScanEngine } from "./query.js";
import { RowGroupStore } from "./row-group-store.js";
import type { QueryEngine, StorageBackend, ValuesCodec } from "./types.js";
import type { WasmCodecs } from "./wasm-codecs.js";
import { initWasmCodecs } from "./wasm-codecs.js";
import { err, ok, type RequestEnvelope, type ResponseEnvelope } from "./worker-protocol.js";

interface WorkerLikeEndpoint {
  postMessage(message: unknown, transfer?: ArrayBufferLike[]): void;
  addEventListener?: (type: "message", listener: (event: { data: unknown }) => void) => void;
  on?: (type: "message", listener: (data: unknown) => void) => void;
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
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
    decodeValuesRange(buf: Uint8Array, startIndex: number, endIndex: number): Float64Array {
      if (buf.byteLength < 4 || endIndex <= startIndex) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const clampedStart = Math.max(0, Math.min(startIndex, n));
      const clampedEnd = Math.max(clampedStart, Math.min(endIndex, n));
      const byteStart = clampedStart * 8;
      const byteEnd = clampedEnd * 8;
      const bytes = Math.max(
        0,
        Math.min(raw.byteLength, byteEnd) - Math.min(raw.byteLength, byteStart)
      );
      if (bytes === 0) return new Float64Array(0);
      const copy = raw.slice(byteStart, byteStart + bytes);
      return new Float64Array(copy.buffer, copy.byteOffset, Math.floor(bytes / 8)).slice();
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
    ) => Promise<unknown>;
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
  /** Factory to create a storage backend. Receives chunk size and optional precision. */
  createStore?: (chunkSize: number, precision?: number) => StorageBackend;
  /** Query engine instance. Defaults to ScanEngine. */
  queryEngine?: QueryEngine;
  /** Default decimal precision for value quantization (e.g. 3 → round to 0.001). */
  precision?: number;
}

export class O11yWorkerRuntime {
  private readonly endpoint: WorkerLikeEndpoint;
  private readonly engine: QueryEngine;
  private createStore: (chunkSize: number, precision?: number) => StorageBackend;
  private store: StorageBackend;
  private wasmReady: Promise<void>;
  private defaultPrecision: number | undefined;
  private wasmCodecs: WasmCodecs | null = null;

  constructor(endpoint?: WorkerLikeEndpoint, config?: WorkerRuntimeConfig) {
    this.endpoint = endpoint ?? resolveEndpoint();
    this.defaultPrecision = config?.precision;
    const codec = createValuesCodec();
    const hasCustomFactory = config?.createStore !== undefined;
    this.createStore =
      config?.createStore ??
      ((cs: number, precision?: number) =>
        new RowGroupStore(
          codec,
          cs,
          () => 0,
          32,
          undefined,
          undefined,
          undefined,
          undefined,
          precision
        ));
    this.engine = config?.queryEngine ?? new ScanEngine();
    this.store = this.createStore(1024, this.defaultPrecision);

    // Load WASM codecs in the background. Only update the factory —
    // never replace a live store that may already contain ingested data.
    // The next `init` message will create a fresh store with WASM codecs.
    this.wasmReady = tryLoadWasm()
      .then((wc) => {
        if (wc) {
          this.wasmCodecs = wc;
          if (!hasCustomFactory) {
            this.createStore = (cs: number, precision?: number) =>
              new RowGroupStore(
                wc.valuesCodec,
                cs,
                () => 0,
                32,
                undefined,
                wc.tsCodec,
                wc.rangeCodec,
                undefined,
                precision,
                wc.quantizeBatch
              );
          }
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
          const precision = payload.precision ?? this.defaultPrecision;
          this.store = this.createStore(chunkSize, precision);
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
        case "batch-ingest": {
          const { count, labels: labelsArr, allTimestampsMs, allValues, offsets } = payload;

          // Validate payload shape before processing.
          if (
            labelsArr.length !== count ||
            offsets.length !== count * 2 ||
            allTimestampsMs.length !== allValues.length
          ) {
            this.send(err(id, new Error("Malformed batch-ingest: shape mismatch"), meta));
            return;
          }

          const msToNs = this.wasmCodecs?.msToNs;
          let totalSamples = 0;
          let ingestedSeries = 0;
          for (let i = 0; i < count; i++) {
            const off = requireDefined(offsets[i * 2], `missing batch offset for series ${i}`);
            const len = requireDefined(offsets[i * 2 + 1], `missing batch length for series ${i}`);
            if (len === 0) continue;

            if (off + len > allTimestampsMs.length) {
              this.send(
                err(id, new Error(`Batch offset out of bounds: off=${off} len=${len}`), meta)
              );
              return;
            }

            const seriesLabels = new Map(
              requireDefined(labelsArr[i], `missing batch labels for series ${i}`)
            );
            const seriesId = this.store.getOrCreateSeries(seriesLabels);

            const msSlice = allTimestampsMs.subarray(off, off + len);
            let tsArr: BigInt64Array;
            if (msToNs) {
              tsArr = msToNs(msSlice);
            } else {
              tsArr = new BigInt64Array(len);
              for (let j = 0; j < len; j++) {
                tsArr[j] = BigInt(
                  Math.round(
                    requireDefined(msSlice[j], `missing batch timestamp ${j} for series ${i}`) *
                      1_000_000
                  )
                );
              }
            }

            const vals = allValues.subarray(off, off + len);
            this.store.appendBatch(seriesId, tsArr, vals);
            totalSamples += len;
            ingestedSeries++;
          }
          this.send(
            ok(
              id,
              { ok: true, type: "batch-ingest", seriesCount: ingestedSeries, totalSamples },
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
        default: {
          const exhaustive: never = payload;
          this.send(
            err(
              id,
              new Error(`Unknown request type: ${(exhaustive as { type: string }).type}`),
              meta
            )
          );
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
