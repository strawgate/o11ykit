import { describe, it, expect } from "vitest";
import { ColumnarTracePolicy } from "../src/codec-columnar.js";
import { ChunkBuilder } from "../src/chunk.js";
import { isAncestorOf, isDescendantOf, isSiblingOf, nestedSetDepth } from "../src/query.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function fixedBytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

const TRACE_A = fixedBytes(16, 0xAA);

function makeSpan(opts: {
  spanId: number;
  parentSpanId?: number;
  name?: string;
  startOffset?: bigint;
  duration?: bigint;
}): SpanRecord {
  const base = 1700000000000000000n;
  const start = base + (opts.startOffset ?? 0n);
  const dur = opts.duration ?? 50_000_000n;
  return {
    traceId: TRACE_A,
    spanId: fixedBytes(8, opts.spanId),
    ...(opts.parentSpanId !== undefined ? { parentSpanId: fixedBytes(8, opts.parentSpanId) } : {}),
    name: opts.name ?? `span-${opts.spanId}`,
    kind: SpanKind.SERVER,
    startTimeUnixNano: start,
    endTimeUnixNano: start + dur,
    durationNanos: dur,
    statusCode: StatusCode.OK,
    attributes: [],
    events: [],
    links: [],
  };
}

// ─── Nested set computation (via ChunkBuilder flush) ─────────────────

describe("Nested set encoding", () => {
  // Build a simple tree:
  //   root (0x01)
  //   ├── child-a (0x02)
  //   │   └── grandchild (0x03)
  //   └── child-b (0x04)
  const root = makeSpan({ spanId: 0x01, name: "root" });
  const childA = makeSpan({ spanId: 0x02, parentSpanId: 0x01, name: "child-a", startOffset: 1n });
  const grandchild = makeSpan({ spanId: 0x03, parentSpanId: 0x02, name: "grandchild", startOffset: 2n });
  const childB = makeSpan({ spanId: 0x04, parentSpanId: 0x01, name: "child-b", startOffset: 3n });

  function buildChunkWithNestedSets(spans: SpanRecord[]): SpanRecord[] {
    const policy = new ColumnarTracePolicy();
    const builder = new ChunkBuilder(policy, 1000);
    for (const s of spans) builder.append(s);
    const chunk = builder.flush();
    expect(chunk).not.toBeNull();
    // Decode the chunk payload to get the nested set fields
    return policy.decodePayload(chunk!.payload, chunk!.header.nSpans, chunk!.header.codecMeta);
  }

  it("assigns nested set numbers to a simple tree", () => {
    const decoded = buildChunkWithNestedSets([root, childA, grandchild, childB]);

    // Find spans by name
    const dRoot = decoded.find(s => s.name === "root")!;
    const dChildA = decoded.find(s => s.name === "child-a")!;
    const dGrandchild = decoded.find(s => s.name === "grandchild")!;
    const dChildB = decoded.find(s => s.name === "child-b")!;

    // Root should enclose all others
    expect(dRoot.nestedSetLeft).toBeDefined();
    expect(dRoot.nestedSetRight).toBeDefined();
    expect(dRoot.nestedSetLeft).toBeLessThan(dChildA.nestedSetLeft!);
    expect(dRoot.nestedSetRight).toBeGreaterThan(dChildB.nestedSetRight!);

    // child-a should enclose grandchild
    expect(dChildA.nestedSetLeft).toBeLessThan(dGrandchild.nestedSetLeft!);
    expect(dChildA.nestedSetRight).toBeGreaterThan(dGrandchild.nestedSetRight!);

    // child-b should NOT enclose grandchild
    expect(dChildB.nestedSetLeft).toBeGreaterThan(dGrandchild.nestedSetRight!);
  });

  it("roundtrips nested set values through encode/decode", () => {
    const decoded = buildChunkWithNestedSets([root, childA, grandchild, childB]);

    // All spans should have nested set fields
    for (const s of decoded) {
      expect(s.nestedSetLeft).toBeDefined();
      expect(s.nestedSetRight).toBeDefined();
    }
  });

  it("handles multiple roots (disconnected spans)", () => {
    const root2 = makeSpan({ spanId: 0x05, name: "root2", startOffset: 100n });
    const decoded = buildChunkWithNestedSets([root, childA, root2]);

    const dRoot = decoded.find(s => s.name === "root")!;
    const dRoot2 = decoded.find(s => s.name === "root2")!;

    // Both are roots - neither encloses the other
    const r1encloses2 = dRoot.nestedSetLeft! < dRoot2.nestedSetLeft! &&
                         dRoot.nestedSetRight! > dRoot2.nestedSetRight!;
    const r2encloses1 = dRoot2.nestedSetLeft! < dRoot.nestedSetLeft! &&
                         dRoot2.nestedSetRight! > dRoot.nestedSetRight!;
    expect(r1encloses2).toBe(false);
    expect(r2encloses1).toBe(false);
  });

  it("handles spans with same traceId correctly", () => {
    // All our test spans share TRACE_A, so nested sets are computed per-trace
    const decoded = buildChunkWithNestedSets([root, childA, grandchild, childB]);
    // DFS numbering should be valid (left < right for each span)
    for (const s of decoded) {
      if (s.nestedSetLeft !== undefined && s.nestedSetRight !== undefined) {
        expect(s.nestedSetLeft).toBeLessThan(s.nestedSetRight);
      }
    }
  });
});

// ─── Structural query helpers ────────────────────────────────────────

describe("Structural queries (nested set model)", () => {
  // Manually create spans with nested set values for deterministic tests
  const root: SpanRecord = {
    traceId: TRACE_A,
    spanId: fixedBytes(8, 0x01),
    name: "root",
    kind: SpanKind.SERVER,
    startTimeUnixNano: 1000n,
    endTimeUnixNano: 2000n,
    durationNanos: 1000n,
    statusCode: StatusCode.OK,
    attributes: [],
    events: [],
    links: [],
    nestedSetLeft: 1,
    nestedSetRight: 8,
    nestedSetParent: 0,
  };
  const childA: SpanRecord = {
    ...root,
    spanId: fixedBytes(8, 0x02),
    parentSpanId: fixedBytes(8, 0x01),
    name: "child-a",
    nestedSetLeft: 2,
    nestedSetRight: 5,
    nestedSetParent: 1,
  };
  const grandchild: SpanRecord = {
    ...root,
    spanId: fixedBytes(8, 0x03),
    parentSpanId: fixedBytes(8, 0x02),
    name: "grandchild",
    nestedSetLeft: 3,
    nestedSetRight: 4,
    nestedSetParent: 2,
  };
  const childB: SpanRecord = {
    ...root,
    spanId: fixedBytes(8, 0x04),
    parentSpanId: fixedBytes(8, 0x01),
    name: "child-b",
    nestedSetLeft: 6,
    nestedSetRight: 7,
    nestedSetParent: 1,
  };

  describe("isAncestorOf", () => {
    it("root is ancestor of all descendants", () => {
      expect(isAncestorOf(root, childA)).toBe(true);
      expect(isAncestorOf(root, grandchild)).toBe(true);
      expect(isAncestorOf(root, childB)).toBe(true);
    });

    it("child-a is ancestor of grandchild", () => {
      expect(isAncestorOf(childA, grandchild)).toBe(true);
    });

    it("child-b is NOT ancestor of grandchild", () => {
      expect(isAncestorOf(childB, grandchild)).toBe(false);
    });

    it("a span is NOT its own ancestor", () => {
      expect(isAncestorOf(root, root)).toBe(false);
    });

    it("returns false when nested set fields are missing", () => {
      const noFields: SpanRecord = { ...root, nestedSetLeft: undefined, nestedSetRight: undefined };
      expect(isAncestorOf(noFields, childA)).toBe(false);
    });
  });

  describe("isDescendantOf", () => {
    it("grandchild is descendant of root", () => {
      expect(isDescendantOf(grandchild, root)).toBe(true);
    });

    it("root is NOT descendant of grandchild", () => {
      expect(isDescendantOf(root, grandchild)).toBe(false);
    });
  });

  describe("isSiblingOf", () => {
    it("child-a and child-b are siblings (same parent)", () => {
      expect(isSiblingOf(childA, childB)).toBe(true);
    });

    it("child-a and grandchild are NOT siblings", () => {
      expect(isSiblingOf(childA, grandchild)).toBe(false);
    });

    it("a span is NOT its own sibling", () => {
      expect(isSiblingOf(childA, childA)).toBe(false);
    });
  });

  describe("nestedSetDepth", () => {
    const allSpans = [root, childA, grandchild, childB];

    it("root has depth 0", () => {
      expect(nestedSetDepth(root, allSpans)).toBe(0);
    });

    it("children have depth 1", () => {
      expect(nestedSetDepth(childA, allSpans)).toBe(1);
      expect(nestedSetDepth(childB, allSpans)).toBe(1);
    });

    it("grandchild has depth 2", () => {
      expect(nestedSetDepth(grandchild, allSpans)).toBe(2);
    });
  });
});
