// ── Storage Backends ────────────────────────────────────────────────

import { FlatStore as _FlatStore, RowGroupStore as _RowGroupStore, initWasmCodecs } from "o11ytsdb";

let _wasmCodecs = null;
let _wasmLoadPromise = null;

export let wasmReady = false;

export async function loadWasm() {
  if (wasmReady) return true;
  if (_wasmLoadPromise) return _wasmLoadPromise;
  _wasmLoadPromise = (async () => {
    try {
      const wasmUrl = new URL("../o11ytsdb.wasm", import.meta.url).href;
      const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
      _wasmCodecs = await initWasmCodecs(module);
      wasmReady = true;
      return true;
    } catch (e) {
      console.warn("WASM load failed:", e);
      _wasmCodecs = null;
      wasmReady = false;
      return false;
    } finally {
      _wasmLoadPromise = null;
    }
  })();
  return _wasmLoadPromise;
}

function createF64PlainCodec() {
  return {
    name: "f64-plain",
    encodeValues(values) {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf) {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      return new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
    },
  };
}

export class FlatStore extends _FlatStore {
  constructor() {
    super("FlatStore");
  }
}

