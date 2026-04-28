// ── Storage Backends ────────────────────────────────────────────────

import {
  FlatStore as _FlatStore,
  RowGroupStore as _RowGroupStore,
  initWasmCodecs,
} from "o11ytsdb";

let _wasmCodecs = null;

export let wasmReady = false;

export async function loadWasm() {
  if (wasmReady) return true;
  try {
    const wasmUrl = new URL("../o11ytsdb.wasm", import.meta.url).href;
    const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
    _wasmCodecs = await initWasmCodecs(module);
    wasmReady = true;
    return true;
  } catch (e) {
    console.warn("WASM load failed:", e);
    wasmReady = false;
    return false;
  }
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

export function createRowGroupStore(chunkSize = 640) {
  const valuesCodec = _wasmCodecs?.xorValuesCodec ?? createF64PlainCodec();
  return new _RowGroupStore(valuesCodec, chunkSize, () => 0, 32, "RowGroupStore");
}

export function createColumnStore(chunkSize = 640) {
  const valuesCodec = _wasmCodecs?.valuesCodec ?? createF64PlainCodec();
  const tsCodec = _wasmCodecs?.tsCodec;
  const rangeCodec = _wasmCodecs?.rangeCodec;
  const nameToGroup = new Map();
  let nextGroupId = 0;
  return new _RowGroupStore(
    valuesCodec,
    chunkSize,
    (labels) => {
      const name = labels.get("__name__") || "";
      let id = nameToGroup.get(name);
      if (id === undefined) {
        id = nextGroupId++;
        nameToGroup.set(name, id);
      }
      return id;
    },
    32,
    "ColumnStore (ALP)",
    tsCodec,
    rangeCodec
  );
}
