/**
 * ByteBuf — growable write buffer for binary codec serialization.
 * ByteReader — sequential reader for binary codec deserialization.
 *
 * These cover all methods used by o11ylogsdb and o11ytracesdb codecs:
 * unsigned integers, signed zigzag varints, float64, length-prefixed
 * strings, raw byte slices, and section-length bookkeeping.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Growable byte buffer for serialization. Little-endian throughout.
 */
export class ByteBuf {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  ensure(needed: number): void {
    if (this.pos + needed <= this.buf.length) return;
    let newCap = this.buf.length * 2;
    while (newCap < this.pos + needed) newCap *= 2;
    const next = new Uint8Array(newCap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeU16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  writeU32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  writeU64(v: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, true);
    this.pos += 8;
  }

  writeFloat64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /**
   * Write an unsigned varint (32-bit). For length prefixes, counts, etc.
   */
  writeUvarint(value: number): void {
    this.ensure(5);
    let v = value >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v > 0) byte |= 0x80;
      this.buf[this.pos++] = byte;
    } while (v > 0);
  }

  /**
   * Write a signed zigzag varint (BigInt). For deltas, signed values.
   * Uses the bit-trick form: (n << 1) ^ (n >> 63).
   */
  writeZigzagVarint(value: bigint): void {
    this.ensure(10);
    const zz = (value << 1n) ^ (value >> 63n);
    let v = zz;
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      this.buf[this.pos++] = byte;
    } while (v > 0n);
  }

  writeBytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  /** Write a length-prefixed UTF-8 string. */
  writeString(s: string): void {
    const encoded = textEncoder.encode(s);
    this.writeUvarint(encoded.length);
    this.writeBytes(encoded);
  }

  /** Reserve space for a u32 section length, return the offset to backpatch. */
  reserveSectionLength(): number {
    const offset = this.pos;
    this.writeU32(0);
    return offset;
  }

  /** Backpatch a section length at the given offset. */
  patchSectionLength(offset: number): void {
    const len = this.pos - offset - 4;
    this.view.setUint32(offset, len, true);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  get length(): number {
    return this.pos;
  }
}

/**
 * Sequential byte reader for deserialization. Little-endian throughout.
 */
export class ByteReader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readU8(): number {
    if (this.pos >= this.buf.length) throw new RangeError("ByteReader: unexpected end of buffer");
    return this.buf[this.pos++] as number;
  }

  readU16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU64(): bigint {
    if (this.pos + 8 > this.buf.length)
      throw new RangeError("ByteReader: unexpected end of buffer");
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readFloat64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /**
   * Read an unsigned varint (32-bit).
   */
  readUvarint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (this.pos >= this.buf.length) throw new RangeError("ByteReader: unexpected end of buffer");
      byte = this.buf[this.pos++] as number;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 35) throw new RangeError("ByteReader: varint overflow");
    } while (byte & 0x80);
    return result >>> 0;
  }

  /**
   * Read a signed zigzag varint (BigInt).
   * Reverses: (n >> 1) ^ -(n & 1).
   */
  readZigzagVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      if (this.pos >= this.buf.length) throw new RangeError("ByteReader: unexpected end of buffer");
      byte = this.buf[this.pos++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) throw new RangeError("ByteReader: varint overflow");
    } while (byte & 0x80);
    return (result >> 1n) ^ -(result & 1n);
  }

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new RangeError(
        `ByteReader: truncated read: need ${n} bytes at offset ${this.pos}, buffer length ${this.buf.length}`
      );
    }
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Read a length-prefixed UTF-8 string. */
  readString(): string {
    const len = this.readUvarint();
    const bytes = this.readBytes(len);
    return textDecoder.decode(bytes);
  }

  /** Number of unread bytes remaining in the buffer. */
  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Read a u32-length-prefixed section as raw bytes. */
  readSection(): Uint8Array {
    const len = this.readU32();
    return this.readBytes(len);
  }
}
