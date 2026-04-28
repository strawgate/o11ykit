import { describe, expect, it } from "vitest";
import { ByteBuf, ByteReader } from "../src/index.js";

describe("ByteBuf", () => {
  it("writeU8 / readU8 round-trips", () => {
    const buf = new ByteBuf(4);
    buf.writeU8(0);
    buf.writeU8(127);
    buf.writeU8(255);
    const r = new ByteReader(buf.finish());
    expect(r.readU8()).toBe(0);
    expect(r.readU8()).toBe(127);
    expect(r.readU8()).toBe(255);
  });

  it("writeU16 / readU16 round-trips", () => {
    const buf = new ByteBuf(4);
    buf.writeU16(0);
    buf.writeU16(1000);
    buf.writeU16(65535);
    const r = new ByteReader(buf.finish());
    expect(r.readU16()).toBe(0);
    expect(r.readU16()).toBe(1000);
    expect(r.readU16()).toBe(65535);
  });

  it("writeU32 / readU32 round-trips", () => {
    const buf = new ByteBuf(4);
    buf.writeU32(0);
    buf.writeU32(123456789);
    buf.writeU32(4294967295);
    const r = new ByteReader(buf.finish());
    expect(r.readU32()).toBe(0);
    expect(r.readU32()).toBe(123456789);
    expect(r.readU32()).toBe(4294967295);
  });

  it("writeU64 / readU64 round-trips", () => {
    const buf = new ByteBuf(16);
    buf.writeU64(0n);
    buf.writeU64(9007199254740993n); // beyond Number.MAX_SAFE_INTEGER
    buf.writeU64(18446744073709551615n); // u64 max
    const r = new ByteReader(buf.finish());
    expect(r.readU64()).toBe(0n);
    expect(r.readU64()).toBe(9007199254740993n);
    expect(r.readU64()).toBe(18446744073709551615n);
  });

  it("writeFloat64 / readFloat64 round-trips", () => {
    const buf = new ByteBuf(32);
    buf.writeFloat64(0.0);
    buf.writeFloat64(3.141592653589793);
    buf.writeFloat64(-1.5e100);
    buf.writeFloat64(Number.NaN);
    const r = new ByteReader(buf.finish());
    expect(r.readFloat64()).toBe(0.0);
    expect(r.readFloat64()).toBe(3.141592653589793);
    expect(r.readFloat64()).toBe(-1.5e100);
    expect(r.readFloat64()).toBeNaN();
  });

  it("writeUvarint / readUvarint round-trips small values", () => {
    const buf = new ByteBuf(16);
    buf.writeUvarint(0);
    buf.writeUvarint(1);
    buf.writeUvarint(127);
    buf.writeUvarint(128);
    buf.writeUvarint(300);
    const r = new ByteReader(buf.finish());
    expect(r.readUvarint()).toBe(0);
    expect(r.readUvarint()).toBe(1);
    expect(r.readUvarint()).toBe(127);
    expect(r.readUvarint()).toBe(128);
    expect(r.readUvarint()).toBe(300);
  });

  it("writeUvarint / readUvarint round-trips large values", () => {
    const buf = new ByteBuf(16);
    buf.writeUvarint(16384); // 3 bytes
    buf.writeUvarint(2097152); // 4 bytes
    buf.writeUvarint(4294967295); // max u32, 5 bytes
    const r = new ByteReader(buf.finish());
    expect(r.readUvarint()).toBe(16384);
    expect(r.readUvarint()).toBe(2097152);
    expect(r.readUvarint()).toBe(4294967295);
  });

  it("writeZigzagVarint / readZigzagVarint round-trips", () => {
    const buf = new ByteBuf(64);
    const values = [0n, 1n, -1n, 63n, -64n, 12345n, -12345n, 2147483647n, -2147483648n];
    for (const v of values) buf.writeZigzagVarint(v);
    const r = new ByteReader(buf.finish());
    for (const v of values) expect(r.readZigzagVarint()).toBe(v);
  });

  it("writeZigzagVarint handles large BigInt values", () => {
    const buf = new ByteBuf(32);
    const big = 9007199254740993n;
    buf.writeZigzagVarint(big);
    buf.writeZigzagVarint(-big);
    const r = new ByteReader(buf.finish());
    expect(r.readZigzagVarint()).toBe(big);
    expect(r.readZigzagVarint()).toBe(-big);
  });

  it("writeBytes / readBytes round-trips", () => {
    const buf = new ByteBuf(16);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    buf.writeBytes(data);
    const r = new ByteReader(buf.finish());
    expect(r.readBytes(5)).toEqual(data);
  });

  it("writeString / readString round-trips", () => {
    const buf = new ByteBuf(64);
    buf.writeString("");
    buf.writeString("hello");
    buf.writeString("日本語"); // multi-byte UTF-8
    const r = new ByteReader(buf.finish());
    expect(r.readString()).toBe("");
    expect(r.readString()).toBe("hello");
    expect(r.readString()).toBe("日本語");
  });

  it("reserveSectionLength / patchSectionLength round-trips", () => {
    const buf = new ByteBuf(64);
    buf.writeU8(0xaa); // prefix
    const offset = buf.reserveSectionLength();
    buf.writeU8(1);
    buf.writeU8(2);
    buf.writeU8(3);
    buf.patchSectionLength(offset);
    buf.writeU8(0xbb); // suffix

    const r = new ByteReader(buf.finish());
    expect(r.readU8()).toBe(0xaa);
    const section = r.readSection();
    expect(section).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.readU8()).toBe(0xbb);
  });

  it("finish returns a subarray of the correct length", () => {
    const buf = new ByteBuf(1024);
    buf.writeU8(42);
    buf.writeU8(43);
    const result = buf.finish();
    expect(result.length).toBe(2);
    expect(result[0]).toBe(42);
    expect(result[1]).toBe(43);
  });

  it("length property tracks position", () => {
    const buf = new ByteBuf(16);
    expect(buf.length).toBe(0);
    buf.writeU8(1);
    expect(buf.length).toBe(1);
    buf.writeU32(100);
    expect(buf.length).toBe(5);
  });

  it("auto-grows when capacity is exceeded", () => {
    const buf = new ByteBuf(4); // tiny initial capacity
    for (let i = 0; i < 100; i++) buf.writeU8(i);
    const r = new ByteReader(buf.finish());
    for (let i = 0; i < 100; i++) expect(r.readU8()).toBe(i);
  });

  it("ensure handles large single writes exceeding 2x current capacity", () => {
    const buf = new ByteBuf(4);
    const bigData = new Uint8Array(100);
    bigData.fill(0xfe);
    buf.writeBytes(bigData);
    expect(buf.finish().length).toBe(100);
  });
});

describe("ByteReader", () => {
  it("remaining tracks bytes left", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const r = new ByteReader(data);
    expect(r.remaining).toBe(5);
    r.readU8();
    expect(r.remaining).toBe(4);
    r.readBytes(3);
    expect(r.remaining).toBe(1);
  });

  it("pos tracks read position", () => {
    const data = new Uint8Array(10);
    const r = new ByteReader(data);
    expect(r.pos).toBe(0);
    r.readU8();
    expect(r.pos).toBe(1);
    r.readU32();
    expect(r.pos).toBe(5);
  });

  it("readU8 throws on empty buffer", () => {
    const r = new ByteReader(new Uint8Array(0));
    expect(() => r.readU8()).toThrow("unexpected end of buffer");
  });

  it("readU64 throws on insufficient bytes", () => {
    const r = new ByteReader(new Uint8Array(4));
    expect(() => r.readU64()).toThrow("unexpected end of buffer");
  });

  it("readBytes throws on insufficient bytes", () => {
    const r = new ByteReader(new Uint8Array(3));
    expect(() => r.readBytes(10)).toThrow("truncated read");
  });

  it("readUvarint throws on truncated input", () => {
    // 0x80 means "more bytes follow" but there are no more
    const r = new ByteReader(new Uint8Array([0x80]));
    expect(() => r.readUvarint()).toThrow("unexpected end of buffer");
  });

  it("readUvarint throws on overflow (too many continuation bytes)", () => {
    // 6 continuation bytes → shift > 35
    const r = new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]));
    expect(() => r.readUvarint()).toThrow("varint overflow");
  });

  it("readZigzagVarint throws on truncated input", () => {
    const r = new ByteReader(new Uint8Array([0x80]));
    expect(() => r.readZigzagVarint()).toThrow("unexpected end of buffer");
  });

  it("readZigzagVarint throws on overflow (too many continuation bytes)", () => {
    // 11 continuation bytes → shift > 70n
    const data = new Uint8Array(12);
    data.fill(0x80);
    const r = new ByteReader(data);
    expect(() => r.readZigzagVarint()).toThrow("varint overflow");
  });

  it("readSection reads length-prefixed section", () => {
    const buf = new ByteBuf(16);
    const sectionOffset = buf.reserveSectionLength();
    buf.writeU8(0x11);
    buf.writeU8(0x22);
    buf.patchSectionLength(sectionOffset);

    const r = new ByteReader(buf.finish());
    const section = r.readSection();
    expect(section).toEqual(new Uint8Array([0x11, 0x22]));
  });

  it("handles buffer with byteOffset (subarray)", () => {
    // Simulate a buffer that's a view into a larger ArrayBuffer
    const big = new Uint8Array(20);
    const buf = new ByteBuf(8);
    buf.writeU32(42);
    const data = buf.finish();
    big.set(data, 8);
    const sub = big.subarray(8, 12);

    const r = new ByteReader(sub);
    expect(r.readU32()).toBe(42);
  });
});

describe("ByteBuf + ByteReader integration", () => {
  it("mixed types round-trip correctly", () => {
    const buf = new ByteBuf(128);
    buf.writeU8(1);
    buf.writeU16(1000);
    buf.writeU32(123456);
    buf.writeU64(999999999999n);
    buf.writeFloat64(2.718281828);
    buf.writeUvarint(300);
    buf.writeZigzagVarint(-42n);
    buf.writeString("test data");
    buf.writeBytes(new Uint8Array([0xde, 0xad]));

    const r = new ByteReader(buf.finish());
    expect(r.readU8()).toBe(1);
    expect(r.readU16()).toBe(1000);
    expect(r.readU32()).toBe(123456);
    expect(r.readU64()).toBe(999999999999n);
    expect(r.readFloat64()).toBeCloseTo(2.718281828);
    expect(r.readUvarint()).toBe(300);
    expect(r.readZigzagVarint()).toBe(-42n);
    expect(r.readString()).toBe("test data");
    expect(r.readBytes(2)).toEqual(new Uint8Array([0xde, 0xad]));
    expect(r.remaining).toBe(0);
  });
});
