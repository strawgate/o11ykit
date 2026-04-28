// ── WASM Codec Loader (delegates to o11ytsdb's initWasmCodecs) ──────

import { initWasmCodecs } from "o11ytsdb";

let _codecs = null;
export let wasmReady = false;
export let wasmLoadError = null;

export async function loadWasm() {
  try {
    const wasmUrl = new URL("../o11ytsdb.wasm", import.meta.url).href;
    const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
    _codecs = await initWasmCodecs(module);
    wasmReady = true;
    return true;
  } catch (e) {
    wasmLoadError = e;
    console.warn("WASM load failed:", e);
    return false;
  }
}

export function getCodecs() {
  return _codecs;
}

export function wasmEncodeValuesALP(values) {
  return _codecs.valuesCodec.encodeValues(values);
}

export function wasmDecodeValuesALP(buf) {
  return _codecs.valuesCodec.decodeValues(buf);
}

export function wasmEncodeTimestamps(timestamps) {
  return _codecs.tsCodec.encodeTimestamps(timestamps);
}

export function wasmDecodeTimestamps(buf) {
  return _codecs.tsCodec.decodeTimestamps(buf);
}
