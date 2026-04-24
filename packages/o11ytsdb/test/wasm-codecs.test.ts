import { afterEach, describe, expect, it, vi } from "vitest";

import { initWasmCodecs } from "../src/wasm-codecs.js";

function createFakeWasmExports() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let nextPtr = 8;

  const allocScratch = (size: number) => {
    const ptr = (nextPtr + 7) & ~7;
    nextPtr = ptr + size;
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
    decodeValuesALPRange: () => 0,
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

  it("returns empty range decode results for short timestamp blobs", async () => {
    const fakeExports = createFakeWasmExports();
    const rangeDecodeALP = vi.fn(fakeExports.rangeDecodeALP);
    fakeExports.rangeDecodeALP = rangeDecodeALP;
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);

    expect(
      codecs.rangeCodec.rangeDecodeValues(new Uint8Array([0]), new Uint8Array(0), 0n, 1n)
    ).toEqual({
      timestamps: new BigInt64Array(0),
      values: new Float64Array(0),
    });
    expect(rangeDecodeALP).not.toHaveBeenCalled();
  });

  it("uses decodeValuesALPRange for bounded ALP value decode", async () => {
    const fakeExports = createFakeWasmExports();
    const decodeValuesALPRange = vi.fn(
      (_inPtr: number, _inLen: number, _lo: number, _hi: number, valPtr: number, _max: number) => {
        const out = new Float64Array(fakeExports.memory.buffer.slice(valPtr, valPtr + 16));
        out[0] = 20;
        out[1] = 30;
        new Uint8Array(fakeExports.memory.buffer).set(new Uint8Array(out.buffer), valPtr);
        return 2;
      }
    );
    fakeExports.decodeValuesALPRange = decodeValuesALPRange;
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);
    const buf = new Uint8Array([0, 4, 0, 0]);
    expect(Array.from(codecs.valuesCodec.decodeValuesRange?.(buf, 1, 3) ?? [])).toEqual([20, 30]);
    expect(decodeValuesALPRange).toHaveBeenCalled();
  });

  it("uses decodeValuesALPRange for bounded ALP value decode views", async () => {
    const fakeExports = createFakeWasmExports();
    const decodeValuesALPRange = vi.fn(
      (_inPtr: number, _inLen: number, _lo: number, _hi: number, valPtr: number, _max: number) => {
        new Float64Array(fakeExports.memory.buffer, valPtr, 2).set([20, 30]);
        return 2;
      }
    );
    fakeExports.decodeValuesALPRange = decodeValuesALPRange;
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);
    const buf = new Uint8Array([0, 4, 0, 0]);
    expect(Array.from(codecs.valuesCodec.decodeValuesRangeView?.(buf, 1, 3) ?? [])).toEqual([
      20, 30,
    ]);
    expect(decodeValuesALPRange).toHaveBeenCalled();
  });

  it("returns a scratch-backed ALP view for single decode", async () => {
    const fakeExports = createFakeWasmExports();
    const decodeValuesALP = vi.fn(
      (_inPtr: number, _inLen: number, valPtr: number, _max: number) => {
        new Float64Array(fakeExports.memory.buffer, valPtr, 2).set([11, 22]);
        return 2;
      }
    );
    fakeExports.decodeValuesALP = decodeValuesALP;
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);
    const buf = new Uint8Array([0, 2, 0, 0]);
    const values = codecs.valuesCodec.decodeValuesView?.(buf);
    expect(values).toBeDefined();
    expect(Array.from(values ?? [])).toEqual([11, 22]);
    expect(decodeValuesALP).toHaveBeenCalled();
  });

  it("returns scratch-backed views for batch decode", async () => {
    const fakeExports = createFakeWasmExports();
    const decodeBatchValuesALP = vi.fn(
      (
        _blobsPtr: number,
        _offsetsPtr: number,
        _sizesPtr: number,
        numBlobs: number,
        outPtr: number,
        chunkSize: number
      ) => {
        for (let i = 0; i < numBlobs; i++) {
          new Float64Array(fakeExports.memory.buffer, outPtr + i * chunkSize * 8, chunkSize).set([
            i + 1,
            i + 2,
          ]);
        }
        return 0;
      }
    );
    fakeExports.decodeBatchValuesALP = decodeBatchValuesALP;
    vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
      exports: fakeExports,
    } as unknown as WebAssembly.Instance);

    const codecs = await initWasmCodecs({} as WebAssembly.Module);
    const blobs = [new Uint8Array([0, 2, 0, 0]), new Uint8Array([0, 2, 0, 0])];
    const decoded = codecs.valuesCodec.decodeBatchValuesView?.(blobs, 2);
    expect(decoded).toBeDefined();
    expect(decoded?.length).toBe(2);
    expect(Array.from(decoded?.[0] ?? [])).toEqual([1, 2]);
    expect(Array.from(decoded?.[1] ?? [])).toEqual([2, 3]);
    expect(decodeBatchValuesALP).toHaveBeenCalled();
  });
});
