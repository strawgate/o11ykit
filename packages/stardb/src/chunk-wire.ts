/**
 * Generic chunk wire format shared by o11ylogsdb and o11ytracesdb.
 *
 * Wire layout (all little-endian):
 *   [4-byte magic] [1-byte version] [4-byte u32 LE header-length] [JSON header] [payload]
 *
 * Each engine supplies its own magic bytes and header type.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ChunkWireOptions {
  /** 4-byte magic identifying the engine. */
  magic: Uint8Array;
  /** Current wire format version (typically 1). */
  version: number;
  /** Engine name for error messages (e.g., "o11ylogsdb"). */
  name: string;
}

/**
 * Serialize a chunk (header + payload) to wire format.
 * Generic over the header type — it's JSON-serialized.
 */
export function serializeChunkWire<H>(
  header: H,
  payload: Uint8Array,
  opts: ChunkWireOptions
): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const totalLen = 4 + 1 + 4 + headerBytes.length + payload.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(opts.magic, 0);
  out[4] = opts.version;
  view.setUint32(5, headerBytes.length, true);
  out.set(headerBytes, 9);
  out.set(payload, 9 + headerBytes.length);
  return out;
}

/**
 * Deserialize wire format back into header + payload.
 * Returns the parsed header (JSON) and raw payload bytes.
 */
export function deserializeChunkWire<H>(
  buf: Uint8Array,
  opts: ChunkWireOptions
): { header: H; payload: Uint8Array } {
  if (buf.length < 9) {
    throw new Error(`${opts.name}: chunk too small`);
  }
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== opts.magic[i]) {
      throw new Error(`${opts.name}: invalid chunk magic`);
    }
  }
  if (buf[4] !== opts.version) {
    throw new Error(`${opts.name}: unsupported chunk version ${buf[4]}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(5, true);
  const headerEnd = 9 + headerLen;
  if (buf.length < headerEnd) {
    throw new Error(`${opts.name}: truncated header`);
  }
  const headerJson = textDecoder.decode(buf.subarray(9, headerEnd));
  const header: H = JSON.parse(headerJson);
  const payload = buf.subarray(headerEnd);
  return { header, payload };
}

/**
 * Compute the wire size of a chunk without allocating.
 */
export function chunkWireSize<H>(header: H, payload: Uint8Array): number {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  return 4 + 1 + 4 + headerBytes.length + payload.length;
}
