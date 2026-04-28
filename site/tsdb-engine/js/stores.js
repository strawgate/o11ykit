// ── Storage Backends (thin adapters over the real o11ytsdb package) ───

import {
  ChunkedStore as _ChunkedStore,
  ColumnStore as _ColumnStore,
  FlatStore as _FlatStore,
  decodeChunk,
  encodeChunk,
} from "o11ytsdb";
import { getCodecs } from "./wasm.js";

// The real stores already have appendBatch(id, timestamps, values) as an
// internal method with the exact same signature the demo callers expect.
// These wrapper subclasses exist only to simplify the constructors.

export class FlatStore extends _FlatStore {
  constructor() {
    super("FlatStore");
  }
}

const xorCodec = { name: "xor-delta", encode: encodeChunk, decode: decodeChunk };

export class ChunkedStore extends _ChunkedStore {
  constructor(chunkSize = 640) {
    super(xorCodec, chunkSize, "ChunkedStore");
  }
}

export class ColumnStore extends _ColumnStore {
  constructor(chunkSize = 640) {
    const codecs = getCodecs();
    const nameToGroup = new Map();
    let nextGroupId = 0;
    super(
      codecs.valuesCodec,
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
      "ColumnStore (ALP)",
      codecs.tsCodec,
      codecs.rangeCodec
    );
  }
}
