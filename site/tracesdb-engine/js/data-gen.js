// @ts-nocheck
// ── Trace Data Generator ─────────────────────────────────────────────
// Generates realistic distributed trace data for the demo.

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} meta
 * @property {() => GeneratedData} generate
 */

/**
 * @typedef {Object} GeneratedData
 * @property {Array} spans
 * @property {number} traceCount
 * @property {number} serviceCount
 * @property {string[]} serviceNames
 */

const SERVICES = {
  gateway: { ops: ["GET /api/users", "POST /api/orders", "GET /api/products", "PUT /api/cart", "DELETE /api/session"] },
  auth: { ops: ["validate-token", "refresh-token", "check-permissions", "decode-jwt"] },
  users: { ops: ["get-user-by-id", "list-users", "update-profile", "create-user"] },
  orders: { ops: ["create-order", "get-order", "list-orders", "cancel-order", "process-payment"] },
  products: { ops: ["get-product", "search-products", "update-inventory", "get-recommendations"] },
  database: { ops: ["SELECT users", "SELECT orders", "INSERT orders", "UPDATE products", "SELECT products"] },
  cache: { ops: ["redis.get", "redis.set", "redis.mget", "redis.del", "redis.expire"] },
  queue: { ops: ["publish-event", "consume-event", "ack-message", "nack-message"] },
  notification: { ops: ["send-email", "send-push", "send-sms", "template-render"] },
  search: { ops: ["index-document", "search-query", "suggest", "facet-query"] },
};

function randomId(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function gaussianRand(mean, stddev) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * stddev;
}

/**
 * Generate spans for a single trace following a service call tree.
 */
function generateTrace(services, depth, width, errorRate, baseTime) {
  const traceId = randomId(16);
  const spans = [];
  const serviceNames = Object.keys(services);

  function makeSpan(serviceName, parentId, currentDepth, startNs) {
    const svc = services[serviceName];
    const opName = pick(svc.ops);
    const spanId = randomId(8);
    const durationMs = Math.max(1, gaussianRand(currentDepth === 0 ? 200 : 50, 30));
    const durationNs = BigInt(Math.round(durationMs * 1_000_000));
    const hasError = Math.random() < errorRate;

    const span = {
      traceId,
      spanId,
      parentSpanId: parentId || undefined,
      name: opName,
      kind: currentDepth === 0 ? 1 : (currentDepth === depth ? 3 : 0),
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs + durationNs,
      durationNanos: durationNs,
      statusCode: hasError ? 2 : 1,
      attributes: [
        { key: "service.name", value: serviceName },
        { key: "http.method", value: opName.startsWith("GET") ? "GET" : opName.startsWith("POST") ? "POST" : "INTERNAL" },
      ],
      events: hasError ? [{ name: "exception", timeUnixNano: startNs + durationNs / 2n, attributes: [{ key: "exception.message", value: "Connection timeout" }] }] : [],
      links: [],
    };

    if (hasError) {
      span.attributes.push({ key: "error", value: true });
      span.attributes.push({ key: "error.message", value: "Connection timeout" });
    }

    spans.push(span);

    // Generate children
    if (currentDepth < depth) {
      const childCount = Math.min(width, Math.floor(randBetween(1, width + 1)));
      let childStart = startNs + BigInt(Math.round(randBetween(1, 5) * 1_000_000));

      for (let i = 0; i < childCount; i++) {
        const childService = pick(serviceNames.filter(s => s !== serviceName));
        makeSpan(childService, spanId, currentDepth + 1, childStart);
        childStart += BigInt(Math.round(randBetween(5, 30) * 1_000_000));
      }
    }
  }

  const rootService = pick(serviceNames.filter(s => s === "gateway" || serviceNames.indexOf(s) < 3));
  makeSpan(rootService, null, 0, baseTime);
  return spans;
}

// ── Scenarios ─────────────────────────────────────────────────────────

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: "microservices",
    name: "Microservices",
    description: "50 traces across 6 services with 3-level depth. Typical web API traffic.",
    meta: "50 traces · ~250 spans · 6 services",
    generate() {
      const svcs = { gateway: SERVICES.gateway, auth: SERVICES.auth, users: SERVICES.users, orders: SERVICES.orders, database: SERVICES.database, cache: SERVICES.cache };
      const spans = [];
      const baseTime = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 50; i++) {
        const traceSpans = generateTrace(svcs, 3, 3, 0.08, baseTime + BigInt(i * 500_000_000));
        spans.push(...traceSpans);
      }
      return { spans, traceCount: 50, serviceCount: 6, serviceNames: Object.keys(svcs) };
    },
  },
  {
    id: "fan-out",
    name: "Fan-Out",
    description: "20 traces with wide fan-out (5-7 children per span). Simulates scatter-gather.",
    meta: "20 traces · ~600 spans · 8 services",
    generate() {
      const svcs = { gateway: SERVICES.gateway, users: SERVICES.users, products: SERVICES.products, search: SERVICES.search, cache: SERVICES.cache, database: SERVICES.database, queue: SERVICES.queue, notification: SERVICES.notification };
      const spans = [];
      const baseTime = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 20; i++) {
        const traceSpans = generateTrace(svcs, 2, 6, 0.05, baseTime + BigInt(i * 1_000_000_000));
        spans.push(...traceSpans);
      }
      return { spans, traceCount: 20, serviceCount: 8, serviceNames: Object.keys(svcs) };
    },
  },
  {
    id: "error-cascade",
    name: "Error Cascade",
    description: "30 traces with high error rate (25%). Database failures propagate up the call chain.",
    meta: "30 traces · ~180 spans · 5 services",
    generate() {
      const svcs = { gateway: SERVICES.gateway, orders: SERVICES.orders, database: SERVICES.database, cache: SERVICES.cache, queue: SERVICES.queue };
      const spans = [];
      const baseTime = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 30; i++) {
        const traceSpans = generateTrace(svcs, 3, 2, 0.25, baseTime + BigInt(i * 300_000_000));
        spans.push(...traceSpans);
      }
      return { spans, traceCount: 30, serviceCount: 5, serviceNames: Object.keys(svcs) };
    },
  },
  {
    id: "deep-stack",
    name: "Deep Stack",
    description: "15 traces with deep call chains (5-6 levels). Simulates complex middleware pipelines.",
    meta: "15 traces · ~300 spans · 10 services",
    generate() {
      const svcs = SERVICES;
      const spans = [];
      const baseTime = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 15; i++) {
        const traceSpans = generateTrace(svcs, 5, 2, 0.1, baseTime + BigInt(i * 2_000_000_000));
        spans.push(...traceSpans);
      }
      return { spans, traceCount: 15, serviceCount: 10, serviceNames: Object.keys(svcs) };
    },
  },
  {
    id: "large",
    name: "Large Scale",
    description: "200 traces across all 10 services. Stress test for the storage engine.",
    meta: "200 traces · ~2000 spans · 10 services",
    generate() {
      const svcs = SERVICES;
      const spans = [];
      const baseTime = BigInt(Date.now()) * 1_000_000n;
      for (let i = 0; i < 200; i++) {
        const traceSpans = generateTrace(svcs, 3, 3, 0.1, baseTime + BigInt(i * 200_000_000));
        spans.push(...traceSpans);
      }
      return { spans, traceCount: 200, serviceCount: 10, serviceNames: Object.keys(svcs) };
    },
  },
];
