// ── WASM ALP Codec Loader ────────────────────────────────────────────

export let wasmExports = null;
export let wasmReady = false;
export let wasmLoadError = null;

export async function loadWasm() {
  try {
    const wasmUrl = new URL("../o11ytsdb.wasm", import.meta.url).href;
    const resp = await fetch(wasmUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), { env: {} });
    wasmExports = instance.exports;
    wasmReady = true;
    return true;
  } catch (e) {
    wasmLoadError = e;
    console.warn("WASM load failed:", e);
    return false;
  }
}

function wasmMem() {
  return new Uint8Array(wasmExports.memory.buffer);
}

export function wasmEncodeValuesALP(values) {
  const n = values.length;
  wasmExports.resetScratch();
  const valPtr = wasmExports.allocScratch(n * 8);
  const outCap = n * 20;
  const outPtr = wasmExports.allocScratch(outCap);
  wasmMem().set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), valPtr);
  const bytesWritten = wasmExports.encodeValuesALP(valPtr, n, outPtr, outCap);
  return new Uint8Array(wasmExports.memory.buffer.slice(outPtr, outPtr + bytesWritten));
}

export function wasmDecodeValuesALP(buf) {
  wasmExports.resetScratch();
  const inPtr = wasmExports.allocScratch(buf.length);
  wasmMem().set(buf, inPtr);
  const maxSamples = (buf[0] << 8) | buf[1];
  const valPtr = wasmExports.allocScratch(maxSamples * 8);
  const n = wasmExports.decodeValuesALP(inPtr, buf.length, valPtr, maxSamples);
  return new Float64Array(wasmExports.memory.buffer.slice(valPtr, valPtr + n * 8));
}

export function wasmEncodeTimestamps(timestamps) {
  const n = timestamps.length;
  wasmExports.resetScratch();
  const tsPtr = wasmExports.allocScratch(n * 8);
  const outCap = n * 20;
  const outPtr = wasmExports.allocScratch(outCap);
  wasmMem().set(
    new Uint8Array(timestamps.buffer, timestamps.byteOffset, timestamps.byteLength),
    tsPtr
  );
  const bytesWritten = wasmExports.encodeTimestamps(tsPtr, n, outPtr, outCap);
  return new Uint8Array(wasmExports.memory.buffer.slice(outPtr, outPtr + bytesWritten));
}

export function wasmDecodeTimestamps(buf) {
  wasmExports.resetScratch();
  const inPtr = wasmExports.allocScratch(buf.length);
  wasmMem().set(buf, inPtr);
  const maxSamples = (buf[0] << 8) | buf[1];
  const tsPtr = wasmExports.allocScratch(maxSamples * 8);
  const n = wasmExports.decodeTimestamps(inPtr, buf.length, tsPtr, maxSamples);
  return new BigInt64Array(wasmExports.memory.buffer.slice(tsPtr, tsPtr + n * 8));
}
