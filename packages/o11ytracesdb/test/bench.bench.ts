import { bench, describe } from "vitest";
import { ColumnarTracePolicy } from "../src/codec-columnar.js";
import { ChunkBuilder } from "../src/chunk.js";
import { TraceStore } from "../src/engine.js";
import { queryTraces, buildSpanTree, criticalPath } from "../src/query.js";
import type { SpanRecord } from "../src/types.js";
import { SpanKind, StatusCode } from "../src/types.js";

// ─── Span generators ─────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

const OPERATIONS = [
  "HTTP GET /api/users",
  "HTTP POST /api/orders",
  "db.query SELECT",
  "redis.get",
  "grpc.server /Service/Method",
  "kafka.consume",
  "internal.process",
  "HTTP GET /api/products",
  "db.query INSERT",
  "http.client external-api",
];

const ATTR_KEYS = [
  "http.method", "http.status_code", "http.url", "http.route",
  "db.system", "db.statement", "rpc.service", "net.peer.name",
  "messaging.system", "service.name",
];

function makeRealisticSpan(traceId: Uint8Array, parentId?: Uint8Array, idx = 0): SpanRecord {
  const start = 1700000000000000000n + BigInt(idx) * 1_000_000n;
  const duration = BigInt(Math.floor(Math.random() * 100_000_000)) + 1_000_000n;
  const name = OPERATIONS[idx % OPERATIONS.length]!;
  const attrCount = 2 + Math.floor(Math.random() * 4);
  const attributes = Array.from({ length: attrCount }, (_, j) => ({
    key: ATTR_KEYS[(idx + j) % ATTR_KEYS.length]!,
    value: j === 0 ? "GET" : j === 1 ? BigInt(200 + idx % 5) : `value-${idx}-${j}`,
  }));

  return {
    traceId,
    spanId: randomBytes(8),
    ...(parentId ? { parentSpanId: parentId } : {}),
    name,
    kind: (idx % 5) as SpanRecord["kind"],
    startTimeUnixNano: start,
    endTimeUnixNano: start + duration,
    durationNanos: duration,
    statusCode: idx % 20 === 0 ? StatusCode.ERROR : StatusCode.OK,
    ...(idx % 20 === 0 ? { statusMessage: "connection timeout" } : {}),
    attributes,
    events: idx % 10 === 0 ? [{
      timeUnixNano: start + 500_000n,
      name: "exception",
      attributes: [{ key: "exception.type", value: "TimeoutError" }],
    }] : [],
    links: [],
  };
}

function makeTraceSpans(n: number): SpanRecord[] {
  const traceId = randomBytes(16);
  const rootId = randomBytes(8);
  const spans: SpanRecord[] = [makeRealisticSpan(traceId, undefined, 0)];
  spans[0] = { ...spans[0]!, spanId: rootId };

  for (let i = 1; i < n; i++) {
    // Random tree structure: parent is a random previous span
    const parentIdx = Math.floor(Math.random() * i);
    const parentSpanId = spans[parentIdx]!.spanId;
    spans.push(makeRealisticSpan(traceId, parentSpanId, i));
  }
  return spans;
}

function makeManyTraces(numTraces: number, spansPerTrace: number): SpanRecord[] {
  const allSpans: SpanRecord[] = [];
  for (let t = 0; t < numTraces; t++) {
    allSpans.push(...makeTraceSpans(spansPerTrace));
  }
  return allSpans;
}

// ─── Precomputed datasets ────────────────────────────────────────────

const spans100 = makeManyTraces(10, 10);
const spans1K = makeManyTraces(50, 20);
const spans10K = makeManyTraces(200, 50);

const policy = new ColumnarTracePolicy();
const encoded100 = policy.encodePayload(spans100);
const encoded1K = policy.encodePayload(spans1K);
const encoded10K = policy.encodePayload(spans10K);

// ─── Encode benchmarks ──────────────────────────────────────────────

describe("encode", () => {
  bench("encode 100 spans", () => {
    policy.encodePayload(spans100);
  });

  bench("encode 1K spans", () => {
    policy.encodePayload(spans1K);
  });

  bench("encode 10K spans", () => {
    policy.encodePayload(spans10K);
  });
});

// ─── Decode benchmarks ──────────────────────────────────────────────

describe("decode", () => {
  bench("decode 100 spans", () => {
    policy.decodePayload(encoded100.payload, spans100.length, encoded100.meta);
  });

  bench("decode 1K spans", () => {
    policy.decodePayload(encoded1K.payload, spans1K.length, encoded1K.meta);
  });

  bench("decode 10K spans", () => {
    policy.decodePayload(encoded10K.payload, spans10K.length, encoded10K.meta);
  });
});

// ─── End-to-end ingest + query ──────────────────────────────────────

describe("ingest + query", () => {
  bench("ingest 1K spans (store.append + flush)", () => {
    const store = new TraceStore({ chunkSize: 256 });
    const resource = { attributes: [{ key: "service.name", value: "bench-svc" }] };
    const scope = { name: "bench", version: "1.0.0" };
    store.append(resource, scope, spans1K);
    store.flush();
  });

  // Pre-build a store to isolate query-only cost
  const queryStore = new TraceStore({ chunkSize: 256 });
  queryStore.append(
    { attributes: [{ key: "service.name", value: "bench-svc" }] },
    { name: "bench", version: "1.0.0" },
    spans1K,
  );
  queryStore.flush();
  // Warm decode cache
  queryTraces(queryStore, { traceId: spans1K[0]!.traceId });

  bench("query by trace_id (1K span store, query-only)", () => {
    queryTraces(queryStore, { traceId: spans1K[0]!.traceId });
  });

  bench("query by time range (1K span store, query-only)", () => {
    queryTraces(queryStore, {
      startTimeNano: 1700000000000000000n,
      endTimeNano: 1700000000500000000n,
      limit: 10,
    });
  });
});

// ─── Tree assembly + critical path ─────────────────────────────────

describe("tree assembly", () => {
  const traceSpans50 = makeTraceSpans(50);
  const traceSpans200 = makeTraceSpans(200);

  bench("buildSpanTree (50 spans)", () => {
    buildSpanTree(traceSpans50);
  });

  bench("buildSpanTree (200 spans)", () => {
    buildSpanTree(traceSpans200);
  });

  bench("criticalPath (50 spans)", () => {
    const roots = buildSpanTree(traceSpans50);
    criticalPath(roots);
  });
});

// ─── Compression ratio reporting ────────────────────────────────────

describe("compression", () => {
  bench("compression ratio (1K realistic spans)", () => {
    const { payload } = policy.encodePayload(spans1K);
    const bytesPerSpan = payload.length / spans1K.length;
    // This bench exists to report bytes/span in timing output
    if (bytesPerSpan > 200) throw new Error(`Regression: ${bytesPerSpan} B/span`);
  });
});
