import { afterEach, describe, expect, it, vi } from "vitest";

import { initWasmCodecs } from "../src/wasm-codecs.js";

function createFakeWasmExports() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let nextPtr = 8;

  const allocScratch = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size;
    return ptr;
  };

  const resetScratch = () => {
    nextPtr = 8;
  };

  return {
    memory,
    allocScratch,
    resetScratch,
    encodeValues: () => 0,
    decodeValues: () => 0,
    encodeValuesWithStats: () => 0,
    encodeValuesALP: () => 0,
    decodeValuesALP: () => 0,
    encodeValuesALPWithStats: () => 0,
    encodeBatchValuesALPWithStats: (
      _valsPtr: number,
      _chunkSize: number,
      _numArrays: number,
      _outPtr: number,
      _outCap: number,
      offsetsPtr: number,
      sizesPtr: number,
      statsPtr: number
    ) => {
      const mem = new Uint8Array(memory.buffer);
      mem.set(new Uint8Array(new Uint32Array([0, 5]).buffer), offsetsPtr);
      mem.set(new Uint8Array(new Uint32Array([4, 4]).buffer), sizesPtr);
      mem.set(new Uint8Array(new Float64Array(16).buffer), statsPtr);
      return 8;
    },
    decodeBatchValuesALP: () => 0,
    encodeTimestamps: () => 0,
    decodeTimestamps: () => 0,
    rangeDecodeALP: () => 0,
    msToNs: () => {},
    quantizeBatch: () => {},
  };
}

describe("initWasmCodecs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid batch slices reported by WASM", async () => {
    const fakeExports = createFakeWasmExports();
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);

    expect(() =>
      codecs.valuesCodec.encodeBatchValuesWithStats([
        Float64Array.from([1, 2]),
        Float64Array.from([3, 4]),
      ])
    ).toThrowError(/invalid batch slice at index 1/);
  });
});
