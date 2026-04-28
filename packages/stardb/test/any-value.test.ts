import { describe, expect, it } from "vitest";
import type { AnyValue, KeyValue } from "../src/index.js";
import { anyValueEquals, anyValueToJson, findAttribute, jsonToAnyValue } from "../src/index.js";

describe("anyValueToJson / jsonToAnyValue round-trip", () => {
  it("handles null", () => {
    expect(anyValueToJson(null)).toBeNull();
    expect(jsonToAnyValue(null)).toBeNull();
  });

  it("handles string", () => {
    expect(anyValueToJson("hello")).toBe("hello");
    expect(jsonToAnyValue("hello")).toBe("hello");
  });

  it("handles number", () => {
    expect(anyValueToJson(42)).toBe(42);
    expect(jsonToAnyValue(42)).toBe(42);
  });

  it("handles boolean", () => {
    expect(anyValueToJson(true)).toBe(true);
    expect(jsonToAnyValue(false)).toBe(false);
  });

  it("handles bigint → {$bi: string}", () => {
    const json = anyValueToJson(123456789012345n);
    expect(json).toEqual({ $bi: "123456789012345" });
    expect(jsonToAnyValue(json)).toBe(123456789012345n);
  });

  it("handles Uint8Array → {$b: hex}", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const json = anyValueToJson(bytes);
    expect(json).toEqual({ $b: "deadbeef" });
    expect(jsonToAnyValue(json)).toEqual(bytes);
  });

  it("handles arrays", () => {
    const arr: AnyValue = ["a", 1, true, null];
    const json = anyValueToJson(arr);
    expect(json).toEqual(["a", 1, true, null]);
    const back = jsonToAnyValue(json);
    expect(back).toEqual(arr);
  });

  it("handles nested arrays with special types", () => {
    const arr: AnyValue = [42n, new Uint8Array([1, 2])];
    const json = anyValueToJson(arr);
    expect(json).toEqual([{ $bi: "42" }, { $b: "0102" }]);
    const back = jsonToAnyValue(json) as AnyValue[];
    expect(back[0]).toBe(42n);
    expect(back[1]).toEqual(new Uint8Array([1, 2]));
  });

  it("handles nested objects (maps)", () => {
    const map: AnyValue = { name: "test", count: 42n, data: new Uint8Array([0xff]) };
    const json = anyValueToJson(map);
    expect(json).toEqual({ name: "test", count: { $bi: "42" }, data: { $b: "ff" } });
    const back = jsonToAnyValue(json) as Record<string, AnyValue>;
    expect(back.name).toBe("test");
    expect(back.count).toBe(42n);
    expect(back.data).toEqual(new Uint8Array([0xff]));
  });

  it("handles deeply nested structures", () => {
    const deep: AnyValue = { a: { b: { c: [1, 2n, "x"] } } };
    const json = anyValueToJson(deep);
    const back = jsonToAnyValue(json);
    expect(back).toEqual({ a: { b: { c: [1, 2n, "x"] } } });
  });
});

describe("anyValueEquals", () => {
  it("null equals null", () => {
    expect(anyValueEquals(null, null)).toBe(true);
  });

  it("null !== non-null", () => {
    expect(anyValueEquals(null, "x")).toBe(false);
    expect(anyValueEquals("x", null)).toBe(false);
  });

  it("string equality", () => {
    expect(anyValueEquals("hello", "hello")).toBe(true);
    expect(anyValueEquals("hello", "world")).toBe(false);
  });

  it("number equality", () => {
    expect(anyValueEquals(42, 42)).toBe(true);
    expect(anyValueEquals(42, 43)).toBe(false);
  });

  it("bigint equality", () => {
    expect(anyValueEquals(100n, 100n)).toBe(true);
    expect(anyValueEquals(100n, 101n)).toBe(false);
  });

  it("boolean equality", () => {
    expect(anyValueEquals(true, true)).toBe(true);
    expect(anyValueEquals(true, false)).toBe(false);
  });

  it("different types are not equal", () => {
    expect(anyValueEquals("42", 42)).toBe(false);
    expect(anyValueEquals(42, 42n)).toBe(false);
    expect(anyValueEquals(true, 1)).toBe(false);
  });

  it("Uint8Array equality", () => {
    expect(anyValueEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(anyValueEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(anyValueEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("array equality (recursive)", () => {
    expect(anyValueEquals(["a", 1], ["a", 1])).toBe(true);
    expect(anyValueEquals(["a", 1], ["a", 2])).toBe(false);
    expect(anyValueEquals(["a"], ["a", "b"])).toBe(false);
  });

  it("nested array equality", () => {
    const a: AnyValue = [["inner", 42n]];
    const b: AnyValue = [["inner", 42n]];
    expect(anyValueEquals(a, b)).toBe(true);
  });

  it("object/map equality (recursive)", () => {
    const a: AnyValue = { x: "hello", y: 42 };
    const b: AnyValue = { x: "hello", y: 42 };
    const c: AnyValue = { x: "hello", y: 43 };
    expect(anyValueEquals(a, b)).toBe(true);
    expect(anyValueEquals(a, c)).toBe(false);
  });

  it("object key count mismatch", () => {
    const a: AnyValue = { x: 1, y: 2 };
    const b: AnyValue = { x: 1 };
    expect(anyValueEquals(a, b)).toBe(false);
  });

  it("object missing key", () => {
    const a: AnyValue = { x: 1, y: 2 };
    const b: AnyValue = { x: 1, z: 2 };
    expect(anyValueEquals(a, b)).toBe(false);
  });

  it("same reference is equal", () => {
    const obj: AnyValue = { deeply: { nested: [1, 2, 3] } };
    expect(anyValueEquals(obj, obj)).toBe(true);
  });
});

describe("findAttribute", () => {
  const attrs: KeyValue[] = [
    { key: "service.name", value: "checkout" },
    { key: "http.method", value: "GET" },
    { key: "http.status_code", value: 200 },
  ];

  it("finds an existing attribute by key", () => {
    expect(findAttribute(attrs, "service.name")).toBe("checkout");
    expect(findAttribute(attrs, "http.method")).toBe("GET");
    expect(findAttribute(attrs, "http.status_code")).toBe(200);
  });

  it("returns undefined for missing key", () => {
    expect(findAttribute(attrs, "nonexistent")).toBeUndefined();
  });

  it("returns first match when duplicates exist", () => {
    const dupes: KeyValue[] = [
      { key: "x", value: "first" },
      { key: "x", value: "second" },
    ];
    expect(findAttribute(dupes, "x")).toBe("first");
  });

  it("handles empty attribute list", () => {
    expect(findAttribute([], "any")).toBeUndefined();
  });
});
