// @ts-nocheck
// ── Trace Data Generator ─────────────────────────────────────────────
// Generates realistic distributed trace data at scale (500K–2M spans).
// Uses streaming generation with progress callbacks.

// ── Service Definitions ──────────────────────────────────────────────

const SERVICES = {
  gateway: {
    ops: [
      "GET /api/users",
      "POST /api/orders",
      "GET /api/products",
      "PUT /api/cart",
      "DELETE /api/session",
      "GET /api/health",
      "POST /api/checkout",
    ],
    latencyMs: [30, 200],
    errorRate: 0.02,
  },
  auth: {
    ops: [
      "validate-token",
      "refresh-token",
      "check-permissions",
      "decode-jwt",
      "issue-token",
      "revoke-token",
    ],
    latencyMs: [5, 40],
    errorRate: 0.01,
  },
  users: {
    ops: [
      "get-user-by-id",
      "list-users",
      "update-profile",
      "create-user",
      "delete-user",
      "verify-email",
    ],
    latencyMs: [10, 80],
    errorRate: 0.03,
  },
  orders: {
    ops: [
      "create-order",
      "get-order",
      "list-orders",
      "cancel-order",
      "process-payment",
      "validate-order",
      "calculate-shipping",
    ],
    latencyMs: [20, 150],
    errorRate: 0.05,
  },
  products: {
    ops: [
      "get-product",
      "search-products",
      "update-inventory",
      "get-recommendations",
      "get-reviews",
      "check-availability",
    ],
    latencyMs: [8, 60],
    errorRate: 0.02,
  },
  database: {
    ops: [
      "SELECT users",
      "SELECT orders",
      "INSERT orders",
      "UPDATE products",
      "SELECT products",
      "BEGIN transaction",
      "COMMIT",
      "SELECT inventory",
      "INSERT audit_log",
    ],
    latencyMs: [2, 50],
    errorRate: 0.04,
  },
  cache: {
    ops: [
      "redis.get",
      "redis.set",
      "redis.mget",
      "redis.del",
      "redis.expire",
      "redis.hget",
      "redis.hset",
    ],
    latencyMs: [0.5, 5],
    errorRate: 0.005,
  },
  queue: {
    ops: [
      "publish-event",
      "consume-event",
      "ack-message",
      "nack-message",
      "dead-letter",
      "retry-message",
    ],
    latencyMs: [3, 25],
    errorRate: 0.03,
  },
  notification: {
    ops: [
      "send-email",
      "send-push",
      "send-sms",
      "template-render",
      "check-preferences",
      "schedule-delivery",
    ],
    latencyMs: [15, 200],
    errorRate: 0.06,
  },
  search: {
    ops: ["index-document", "search-query", "suggest", "facet-query", "scroll", "aggregate"],
    latencyMs: [5, 100],
    errorRate: 0.02,
  },
  payment: {
    ops: [
      "charge-card",
      "refund",
      "verify-payment",
      "create-intent",
      "capture-payment",
      "void-transaction",
    ],
    latencyMs: [50, 500],
    errorRate: 0.08,
  },
  shipping: {
    ops: [
      "calculate-rate",
      "create-label",
      "track-package",
      "estimate-delivery",
      "validate-address",
    ],
    latencyMs: [20, 150],
    errorRate: 0.04,
  },
};

const ENVIRONMENTS = ["production", "staging", "canary"];
const K8S_NAMESPACES = ["default", "services", "data", "infra"];

const _HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const _HTTP_STATUS_CODES = [200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503];
const _DB_SYSTEMS = ["postgresql", "mysql", "redis", "elasticsearch", "mongodb"];

const ERROR_MESSAGES = [
  "Connection timeout after 30000ms",
  "Connection refused: ECONNREFUSED 10.0.0.5:5432",
  "OOM: JavaScript heap out of memory",
  "DeadlineExceeded: context deadline exceeded",
  "StatusCode 503: Service Unavailable",
  "ENOTFOUND: DNS resolution failed for db-primary.internal",
  "Circuit breaker open for service orders",
  "Rate limit exceeded: 429 Too Many Requests",
  "TLS handshake timeout",
  "Connection pool exhausted (max=50, active=50, idle=0)",
];

const STACK_TRACES = [
  `Error: Connection timeout after 30000ms
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
    at ClientRequest.handleTimeout (/app/src/http-client.js:45:11)
    at Timeout._onTimeout (/app/node_modules/axios/lib/adapters/http.js:237:13)`,
  `Error: ECONNREFUSED 10.0.0.5:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
    at Pool.connect (/app/node_modules/pg-pool/index.js:45:12)
    at DBClient.query (/app/src/db/client.js:23:28)`,
  `RangeError: Maximum call stack size exceeded
    at Object.serialize (/app/src/serializer.js:12:5)
    at processSpan (/app/src/pipeline.js:89:22)
    at batchProcess (/app/src/pipeline.js:134:9)`,
];

// ── Helpers ──────────────────────────────────────────────────────────

function randomId(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

function _randomHexId(len) {
  const buf = randomId(len);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
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
  return Math.max(0, mean + z * stddev);
}

function randomPodName(svc) {
  const suffix = Math.random().toString(36).slice(2, 7);
  const hash = Math.random().toString(36).slice(2, 7);
  return `${svc}-${suffix}-${hash}`;
}

// ── Resource Attributes ──────────────────────────────────────────────

function buildResourceAttrs(serviceName) {
  return [
    { key: "service.name", value: serviceName },
    {
      key: "service.version",
      value: `1.${Math.floor(Math.random() * 20)}.${Math.floor(Math.random() * 50)}`,
    },
    { key: "deployment.environment", value: pick(ENVIRONMENTS) },
    { key: "k8s.namespace.name", value: pick(K8S_NAMESPACES) },
    { key: "k8s.pod.name", value: randomPodName(serviceName) },
    { key: "host.name", value: `node-${Math.floor(Math.random() * 20)}.cluster.local` },
    { key: "telemetry.sdk.language", value: "nodejs" },
    { key: "telemetry.sdk.name", value: "opentelemetry" },
  ];
}

// ── Span Attributes Builder ──────────────────────────────────────────

function buildSpanAttrs(serviceName, opName, hasError, depth) {
  const attrs = [{ key: "service.name", value: serviceName }];

  if (
    opName.startsWith("GET ") ||
    opName.startsWith("POST ") ||
    opName.startsWith("PUT ") ||
    opName.startsWith("DELETE ")
  ) {
    attrs.push({ key: "http.method", value: opName.split(" ")[0] });
    attrs.push({
      key: "http.url",
      value: `https://${serviceName}.internal${opName.split(" ")[1]}`,
    });
    attrs.push({
      key: "http.status_code",
      value: hasError ? pick([500, 502, 503]) : pick([200, 201, 204]),
    });
    attrs.push({ key: "http.route", value: opName.split(" ")[1] });
  } else if (
    opName.startsWith("SELECT") ||
    opName.startsWith("INSERT") ||
    opName.startsWith("UPDATE") ||
    opName.startsWith("BEGIN") ||
    opName.startsWith("COMMIT")
  ) {
    attrs.push({ key: "db.system", value: pick(["postgresql", "mysql"]) });
    attrs.push({ key: "db.statement", value: opName });
    attrs.push({ key: "db.name", value: "app_primary" });
    if (Math.random() < 0.4) {
      attrs.push({ key: "db.operation", value: opName.split(" ")[0] });
    }
  } else if (opName.startsWith("redis.")) {
    attrs.push({ key: "db.system", value: "redis" });
    attrs.push({ key: "db.operation", value: opName.replace("redis.", "") });
  } else if (serviceName === "search") {
    attrs.push({ key: "db.system", value: "elasticsearch" });
    attrs.push({ key: "db.operation", value: opName });
  } else if (serviceName === "queue") {
    attrs.push({ key: "messaging.system", value: "rabbitmq" });
    attrs.push({ key: "messaging.operation", value: opName });
    attrs.push({
      key: "messaging.destination",
      value: `${pick(["orders", "notifications", "audit"])}.exchange`,
    });
  }

  if (hasError) {
    attrs.push({ key: "error", value: true });
    attrs.push({ key: "otel.status_code", value: "ERROR" });
    attrs.push({ key: "error.message", value: pick(ERROR_MESSAGES) });
  }

  if (depth === 0) {
    attrs.push({ key: "net.peer.name", value: `${serviceName}.internal` });
    attrs.push({ key: "net.peer.port", value: pick([8080, 8443, 3000, 5000]) });
  }

  return attrs;
}

// ── Events Builder ───────────────────────────────────────────────────

function buildEvents(hasError, startNs, durationNs) {
  const events = [];
  if (hasError) {
    events.push({
      name: "exception",
      timeUnixNano: startNs + durationNs / 2n,
      attributes: [
        {
          key: "exception.type",
          value: pick(["Error", "TimeoutError", "ConnectionError", "RangeError"]),
        },
        { key: "exception.message", value: pick(ERROR_MESSAGES) },
        { key: "exception.stacktrace", value: pick(STACK_TRACES) },
      ],
    });
  }
  if (Math.random() < 0.05) {
    events.push({
      name: "log",
      timeUnixNano: startNs + BigInt(Math.round(Number(durationNs) * Math.random())),
      attributes: [
        { key: "log.severity", value: pick(["INFO", "WARN", "DEBUG"]) },
        {
          key: "log.message",
          value: pick([
            "Cache miss",
            "Retry attempt 2",
            "Slow query detected",
            "Connection pool resized",
          ]),
        },
      ],
    });
  }
  return events;
}

// ── Trace Tree Generator ─────────────────────────────────────────────

function generateTrace(
  serviceNames,
  serviceDefs,
  depth,
  width,
  errorRate,
  baseTime,
  cascadeErrors
) {
  const traceId = randomId(16);
  const spans = [];
  let errorCascading = false;

  function makeSpan(serviceName, parentId, currentDepth, startNs) {
    const svc = serviceDefs[serviceName];
    if (!svc) return;

    const opName = pick(svc.ops);
    const spanId = randomId(8);

    const [minLat, maxLat] = svc.latencyMs;
    const baseDur = gaussianRand((minLat + maxLat) / 2, (maxLat - minLat) / 4);
    const durationMs = Math.max(0.1, baseDur * (errorCascading ? 3 : 1));
    const durationNs = BigInt(Math.round(durationMs * 1_000_000));

    const effectiveErrorRate = errorCascading ? Math.min(errorRate * 4, 0.9) : errorRate;
    const hasError = Math.random() < effectiveErrorRate;
    if (hasError && cascadeErrors && currentDepth <= 1) errorCascading = true;

    const span = {
      traceId,
      spanId,
      parentSpanId: parentId,
      name: opName,
      kind: currentDepth === 0 ? 2 : serviceName === "database" || serviceName === "cache" ? 3 : 1,
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs + durationNs,
      durationNanos: durationNs,
      statusCode: hasError ? 2 : 1,
      attributes: buildSpanAttrs(serviceName, opName, hasError, currentDepth),
      events: buildEvents(hasError, startNs, durationNs),
      links: [],
    };

    spans.push(span);

    if (currentDepth < depth && !hasError) {
      const childCount = Math.min(width, Math.max(1, Math.floor(randBetween(1, width + 1))));
      let childStart = startNs + BigInt(Math.round(randBetween(0.5, 3) * 1_000_000));

      for (let i = 0; i < childCount; i++) {
        const available = serviceNames.filter((s) => s !== serviceName);
        if (available.length === 0) break;
        const childService = pick(available);
        makeSpan(childService, spanId, currentDepth + 1, childStart);
        childStart += BigInt(Math.round(randBetween(2, 15) * 1_000_000));
      }
    }
  }

  const rootCandidates = serviceNames.filter(
    (s) => s === "gateway" || s === "auth" || serviceNames.indexOf(s) < 3
  );
  makeSpan(pick(rootCandidates), undefined, 0, baseTime);
  return spans;
}

// ── Scenario Definitions ─────────────────────────────────────────────

/** @type {Array<{id: string, name: string, emoji: string, description: string, meta: Object, generate: Function}>} */
export const SCENARIOS = [
  {
    id: "microservices",
    name: "Microservices Platform",
    emoji: "🌐",
    description: "10 services, 200K+ spans, realistic call graph with auth, DB, cache layers.",
    meta: { services: 10, targetSpans: 250_000, depth: 3, width: 3, errorRate: 0.05 },
    sampleOps: ["GET /api/users", "validate-token", "SELECT users", "redis.get"],
  },
  {
    id: "database-heavy",
    name: "Database Heavy",
    emoji: "🗄️",
    description: "5 services with deep DB spans, connection pools, and transaction patterns.",
    meta: { services: 5, targetSpans: 200_000, depth: 4, width: 2, errorRate: 0.04 },
    sampleOps: ["SELECT orders", "BEGIN transaction", "INSERT audit_log", "COMMIT"],
  },
  {
    id: "error-cascade",
    name: "Error Cascade",
    emoji: "💥",
    description: "8 services with cascading failures. DB timeouts propagate through the stack.",
    meta: { services: 8, targetSpans: 150_000, depth: 3, width: 3, errorRate: 0.25 },
    sampleOps: ["Connection timeout", "Circuit breaker open", "503 Service Unavailable"],
  },
  {
    id: "fan-out",
    name: "Fan-Out / Scatter-Gather",
    emoji: "📡",
    description: "6 services with wide fan-out patterns. Map-reduce style parallel calls.",
    meta: { services: 6, targetSpans: 300_000, depth: 2, width: 8, errorRate: 0.03 },
    sampleOps: ["search-query", "facet-query", "aggregate", "get-recommendations"],
  },
  {
    id: "high-volume",
    name: "High Volume Load Test",
    emoji: "🔥",
    description: "12 services, 1M+ spans simulating a production load test.",
    meta: { services: 12, targetSpans: 1_000_000, depth: 3, width: 4, errorRate: 0.08 },
    sampleOps: ["GET /api/products", "charge-card", "send-push", "create-label"],
  },
  {
    id: "custom",
    name: "Custom Configuration",
    emoji: "⚙️",
    description:
      "Configure your own scenario: choose services, trace count, depth, and error rate.",
    meta: { services: 0, targetSpans: 0, depth: 0, width: 0, errorRate: 0 },
    sampleOps: [],
  },
];

// ── Scenario Service Sets ────────────────────────────────────────────

const SCENARIO_SERVICES = {
  microservices: [
    "gateway",
    "auth",
    "users",
    "orders",
    "products",
    "database",
    "cache",
    "queue",
    "notification",
    "search",
  ],
  "database-heavy": ["gateway", "orders", "database", "cache", "queue"],
  "error-cascade": ["gateway", "auth", "users", "orders", "products", "database", "cache", "queue"],
  "fan-out": ["gateway", "products", "search", "cache", "database", "queue"],
  "high-volume": [
    "gateway",
    "auth",
    "users",
    "orders",
    "products",
    "database",
    "cache",
    "queue",
    "notification",
    "search",
    "payment",
    "shipping",
  ],
};

// ── Streaming Generator ──────────────────────────────────────────────

/**
 * Generate scenario data with streaming progress.
 * @param {string} scenarioId
 * @param {Object} [options] Override meta for custom scenario
 * @param {function} [onProgress] Called with { phase, current, total, spans }
 * @returns {Promise<{spans: Array, traceCount: number, serviceCount: number, serviceNames: string[]}>}
 */
export async function generateScenarioData(scenarioId, options = {}, onProgress = null) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

  const meta = { ...scenario.meta, ...options };
  const serviceNames =
    scenarioId === "custom"
      ? (options.services || SCENARIO_SERVICES.microservices).slice(0, meta.services || 6)
      : SCENARIO_SERVICES[scenarioId] || SCENARIO_SERVICES.microservices;

  const serviceDefs = {};
  for (const name of serviceNames) {
    serviceDefs[name] = SERVICES[name] || SERVICES.gateway;
  }

  // Build one resource per service (shared across all spans for that service)
  const resources = {};
  for (const name of serviceNames) {
    resources[name] = { attributes: buildResourceAttrs(name) };
  }

  const targetSpans = meta.targetSpans || 100_000;
  const depth = meta.depth || 3;
  const width = meta.width || 3;
  const errorRate = meta.errorRate || 0.05;
  const cascadeErrors = scenarioId === "error-cascade";

  const avgSpansPerTrace = estimateSpansPerTrace(depth, width);
  const totalTraces = Math.max(10, Math.ceil(targetSpans / avgSpansPerTrace));
  const batchSize = Math.min(50, Math.max(5, Math.ceil(totalTraces / 100)));

  const allSpans = [];
  const baseTime = BigInt(Date.now() - 3600_000) * 1_000_000n;
  let traceIdx = 0;

  for (let batch = 0; batch < totalTraces; batch += batchSize) {
    const end = Math.min(batch + batchSize, totalTraces);

    for (let i = batch; i < end; i++) {
      const traceTime = baseTime + BigInt(Math.round(i * (3_600_000_000_000 / totalTraces)));
      const traceSpans = generateTrace(
        serviceNames,
        serviceDefs,
        depth,
        width,
        errorRate,
        traceTime,
        cascadeErrors
      );
      allSpans.push(...traceSpans);
      traceIdx++;
    }

    if (onProgress) {
      onProgress({
        phase: "generating",
        current: traceIdx,
        total: totalTraces,
        spans: allSpans.length,
      });
    }

    // Yield to main thread
    await new Promise((r) => setTimeout(r, 0));
  }

  if (onProgress) {
    onProgress({
      phase: "complete",
      current: totalTraces,
      total: totalTraces,
      spans: allSpans.length,
    });
  }

  return {
    spans: allSpans,
    traceCount: traceIdx,
    serviceCount: serviceNames.length,
    serviceNames,
    resources,
  };
}

function estimateSpansPerTrace(depth, width) {
  let total = 1;
  let levelSize = 1;
  for (let d = 0; d < depth; d++) {
    levelSize = Math.ceil(levelSize * width * 0.7);
    total += levelSize;
  }
  return total;
}

/** Quick estimate for UI display */
export function estimateScenarioSpans(scenario) {
  if (!scenario.meta?.targetSpans) return 0;
  return scenario.meta.targetSpans;
}

/** Estimate raw memory for UI display */
export function estimateScenarioBytes(scenario) {
  return estimateScenarioSpans(scenario) * 280;
}
