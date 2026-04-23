import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerPartitionPayload } from "../js/query-worker-store.js";

function makeLabels(metric, host) {
  return new Map([
    ["__name__", metric],
    ["host", host],
  ]);
}

describe("buildWorkerPartitionPayload", () => {
  const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;

  afterEach(() => {
    if (originalSharedArrayBuffer) {
      globalThis.SharedArrayBuffer = originalSharedArrayBuffer;
    } else {
      delete globalThis.SharedArrayBuffer;
    }
  });

  it("deduplicates repeated ArrayBuffers in the transfer list", () => {
    const sharedTs = new Uint8Array([1, 2, 3, 4]);
    const valueA = new Uint8Array([11, 12]);
    const valueB = new Uint8Array([21, 22]);

    const store = {
      _backendType: "column",
      labels(id) {
        return id === 0 ? makeLabels("cpu", "a") : makeLabels("cpu", "b");
      },
      getChunkInfo(id) {
        return {
          _isColumnStore: true,
          frozen: [
            {
              minT: 1n,
              maxT: 2n,
              count: 2,
              compressedValues: id === 0 ? valueA : valueB,
              tsChunkCompressed: sharedTs,
            },
          ],
          hot: {
            count: 0,
            timestamps: new BigInt64Array(0),
            values: new Float64Array(0),
          },
        };
      },
    };

    const payload = buildWorkerPartitionPayload(store, [0, 1]);
    expect(payload.kind).toBe("column");
    expect(payload.transfer).toHaveLength(3);
    expect(new Set(payload.transfer).size).toBe(3);
  });

  it("clones non-SAB frozen buffers so worker transfer does not detach store buffers", () => {
    delete globalThis.SharedArrayBuffer;

    const sharedTs = new Uint8Array([1, 2, 3, 4]);
    const valueA = new Uint8Array([11, 12]);
    const valueB = new Uint8Array([21, 22]);

    const store = {
      _backendType: "column",
      labels(id) {
        return id === 0 ? makeLabels("cpu", "a") : makeLabels("cpu", "b");
      },
      getChunkInfo(id) {
        return {
          _isColumnStore: true,
          frozen: [
            {
              minT: 1n,
              maxT: 2n,
              count: 2,
              compressedValues: id === 0 ? valueA : valueB,
              tsChunkCompressed: sharedTs,
            },
          ],
          hot: {
            count: 0,
            timestamps: new BigInt64Array(0),
            values: new Float64Array(0),
          },
        };
      },
    };

    const payload = buildWorkerPartitionPayload(store, [0, 1]);
    const ts0 = payload.series[0].frozen[0].compressedTimestamps;
    const ts1 = payload.series[1].frozen[0].compressedTimestamps;
    const v0 = payload.series[0].frozen[0].compressedValues;

    expect(ts0).not.toBe(sharedTs);
    expect(ts0.buffer).not.toBe(sharedTs.buffer);
    expect(ts0).toBe(ts1);
    expect(v0).not.toBe(valueA);
    expect(v0.buffer).not.toBe(valueA.buffer);
    expect(sharedTs.byteLength).toBe(4);
    expect(valueA.byteLength).toBe(2);
  });
});
