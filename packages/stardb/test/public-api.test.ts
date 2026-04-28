/**
 * Pin the public API surface. If a downstream `*db` engine relies on
 * any of these names, deleting or renaming should fail this test
 * loudly rather than break consumers silently at the next bump.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AnyValue,
  Codec,
  InstrumentationScope,
  IntCodec,
  KeyValue,
  Resource,
  SeverityText,
  StreamId,
  StringCodec,
} from "../src/index.js";
import * as stardb from "../src/index.js";

// Single source of truth for every runtime symbol the package promises.
// Adding or removing one without updating this list fails both tests below.
const RUNTIME_EXPORTS = [
  "CodecRegistry",
  "defaultRegistry",
  "GzipCodec",
  "lengthPrefixStringCodec",
  "rawCodec",
  "rawInt64Codec",
  "ZstdCodec",
  "ByteBuf",
  "ByteReader",
  "StreamRegistry",
  "chunkWireSize",
  "deserializeChunkWire",
  "serializeChunkWire",
  "bytesEqual",
  "bytesToHex",
  "fnv1aBytes",
  "hexToBytes",
  "nowMillis",
] as const;

describe("stardb public API", () => {
  it("exports every documented runtime symbol", () => {
    for (const name of RUNTIME_EXPORTS) {
      expect(stardb, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("does not leak unintentional symbols", () => {
    const allowed = new Set<string>(RUNTIME_EXPORTS);
    const unexpected = Object.keys(stardb).filter((k) => !allowed.has(k));
    expect(unexpected, `unexpected exports: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("preserves the structural shape of OTLP types", () => {
    const sev: SeverityText = "INFO";
    const kv: KeyValue = { key: "service.name", value: "checkout" };
    const resource: Resource = { attributes: [kv] };
    const scope: InstrumentationScope = { name: "io.opentelemetry.sdk", version: "1.0.0" };
    const id: StreamId = 42;
    const value: AnyValue = { nested: ["a", 1, 2n, true, null, new Uint8Array([1])] };
    expect(sev).toBe("INFO");
    expect(resource.attributes[0]?.key).toBe("service.name");
    expect(scope.name).toBe("io.opentelemetry.sdk");
    expect(id).toBe(42);
    expect(value).toBeDefined();
  });

  it("Codec / StringCodec / IntCodec interfaces are assignable from baseline impls", () => {
    expectTypeOf(stardb.rawCodec).toMatchTypeOf<Codec>();
    expectTypeOf(stardb.lengthPrefixStringCodec).toMatchTypeOf<StringCodec>();
    expectTypeOf(stardb.rawInt64Codec).toMatchTypeOf<IntCodec>();
  });
});
