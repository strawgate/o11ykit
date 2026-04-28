// @ts-nocheck
// ── Log Data Generator ────────────────────────────────────────────────
// Generates realistic OTLP log data at scale (100K–2M records).
// Produces a mix of templated text logs, structured JSON (KVList) logs,
// and rare free-text logs matching the body shape distribution:
// ~61% templated, ~39% KVList, <1% free-text.

// ── Service Definitions ──────────────────────────────────────────────

const SERVICES = {
  "api-gateway": {
    templates: [
      "Received {method} request to {path} from {ip}",
      "Request completed in {duration}ms with status {status}",
      "Rate limit exceeded for client {clientId} on {path}",
      "Authentication header missing for {path}",
      "Circuit breaker tripped for upstream {service}",
      "Retrying request to {service} (attempt {attempt}/3)",
      "TLS handshake completed in {duration}ms for {domain}",
      "Connection pool at {percent}% capacity ({active}/{max})",
    ],
    structured: true,
    severityWeights: { TRACE: 5, DEBUG: 15, INFO: 60, WARN: 12, ERROR: 7, FATAL: 1 },
    logRate: 2000,
  },
  "user-service": {
    templates: [
      "User {userId} authenticated via {method}",
      "Password reset requested for {email}",
      "Session {sessionId} expired after {ttl}s",
      "Profile update for user {userId}: {field} changed",
      "Failed login attempt for {email} from {ip} (attempt {count})",
      "Token refresh issued for session {sessionId}",
      "Account locked for {email} after {count} failed attempts",
      "RBAC check: user {userId} {result} for {permission}",
    ],
    structured: true,
    severityWeights: { TRACE: 3, DEBUG: 10, INFO: 55, WARN: 20, ERROR: 10, FATAL: 2 },
    logRate: 800,
  },
  "order-processor": {
    templates: [
      "Order {orderId} created by user {userId} total={amount}",
      "Payment processing for order {orderId} via {provider}",
      "Payment {result} for order {orderId} ({reason})",
      "Inventory reserved: {quantity}x {sku} for order {orderId}",
      "Inventory insufficient for {sku}: requested={requested} available={available}",
      "Order {orderId} status transition: {from} -> {to}",
      "Shipping label generated for order {orderId} carrier={carrier}",
      "Refund initiated for order {orderId} amount={amount}",
    ],
    structured: true,
    severityWeights: { TRACE: 2, DEBUG: 8, INFO: 50, WARN: 25, ERROR: 12, FATAL: 3 },
    logRate: 500,
  },
  database: {
    templates: [
      "Query executed in {duration}ms: {query}",
      "Connection pool: active={active} idle={idle} waiting={waiting}",
      "Slow query detected ({duration}ms): {query}",
      "Transaction {txId} committed ({tables} tables, {rows} rows)",
      "Transaction {txId} rolled back: {reason}",
      "Index scan on {table}.{index}: {rows} rows examined",
      "Deadlock detected between transactions {txId1} and {txId2}",
      "Replication lag: {lag}ms on replica {replica}",
    ],
    structured: false,
    severityWeights: { TRACE: 10, DEBUG: 20, INFO: 40, WARN: 20, ERROR: 8, FATAL: 2 },
    logRate: 1500,
  },
  "cache-layer": {
    templates: [
      "Cache {result} for key {key} (ttl={ttl}s)",
      "Cache eviction: {count} keys removed, freed {bytes} bytes",
      "Cache miss ratio: {ratio}% over last {window}s",
      "Memory pressure: {used}/{max} MB, evicting LRU entries",
      "Warm-up completed: {count} keys loaded in {duration}ms",
      "Replication sync with {peer}: {delta} keys transferred",
    ],
    structured: false,
    severityWeights: { TRACE: 8, DEBUG: 25, INFO: 50, WARN: 12, ERROR: 4, FATAL: 1 },
    logRate: 3000,
  },
  "message-queue": {
    templates: [
      "Message published to {topic} partition={partition} offset={offset}",
      "Consumer group {group} committed offset {offset} for {topic}",
      "Consumer lag: {lag} messages behind on {topic}/{partition}",
      "Dead letter: message {msgId} moved after {retries} retries",
      "Partition rebalance: assigned [{partitions}] to consumer {consumerId}",
      "Batch produced: {count} messages ({bytes} bytes) to {topic}",
    ],
    structured: true,
    severityWeights: { TRACE: 5, DEBUG: 15, INFO: 60, WARN: 15, ERROR: 4, FATAL: 1 },
    logRate: 4000,
  },
};

const SERVICE_NAMES = Object.keys(SERVICES);

const SEVERITY_LEVELS = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 };

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const HTTP_PATHS = [
  "/api/v2/users",
  "/api/v2/orders",
  "/api/v2/products",
  "/api/v2/cart",
  "/api/v2/checkout",
  "/api/v2/inventory",
  "/api/v2/auth/token",
  "/api/v2/search",
  "/health",
  "/metrics",
];
const HTTP_STATUS = [200, 200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503];
const IPS = ["10.0.1.42", "10.0.2.17", "10.0.3.99", "192.168.1.100", "172.16.0.5", "10.0.1.200"];
const PROVIDERS = ["stripe", "paypal", "square", "braintree"];
const CARRIERS = ["fedex", "ups", "usps", "dhl"];
const DB_TABLES = ["users", "orders", "products", "inventory", "sessions", "payments"];
const TOPICS = ["orders.created", "payments.processed", "inventory.updated", "notifications.send"];

// ── Dataset Presets ──────────────────────────────────────────────────

export const DATASET_PRESETS = {
  small: {
    label: "Small (10K logs, ~170 KB)",
    count: 10_000,
    durationMinutes: 5,
    description: "Quick demo. Loads instantly.",
  },
  medium: {
    label: "Medium (100K logs, ~1.7 MB)",
    count: 100_000,
    durationMinutes: 30,
    description: "Realistic workload. Fast queries.",
  },
  large: {
    label: "Large (500K logs, ~8.5 MB)",
    count: 500_000,
    durationMinutes: 120,
    description: "Stress test. Sub-second queries with pruning.",
  },
  massive: {
    label: "Massive (2M logs, ~34 MB)",
    count: 2_000_000,
    durationMinutes: 480,
    description: "Production scale. Tests memory efficiency.",
  },
};

// ── Random Helpers ───────────────────────────────────────────────────

let _seed = 42;
function mulberry32() {
  _seed += 0x6d2b79f5;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randInt(min, max) {
  return min + Math.floor(mulberry32() * (max - min + 1));
}

function pick(arr) {
  return arr[Math.floor(mulberry32() * arr.length)];
}

function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = mulberry32() * total;
  for (const [key, weight] of entries) {
    r -= weight;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function uuid() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) s += "-";
    s += hex[Math.floor(mulberry32() * 16)];
  }
  return s;
}

function shortId() {
  return Math.floor(mulberry32() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

function ip() {
  return pick(IPS);
}

// ── Template Variable Generators ─────────────────────────────────────

function generateTemplateVars(template, _service) {
  const vars = {};
  if (template.includes("{method}")) vars.method = pick(HTTP_METHODS);
  if (template.includes("{path}")) vars.path = pick(HTTP_PATHS);
  if (template.includes("{ip}")) vars.ip = ip();
  if (template.includes("{duration}")) vars.duration = randInt(1, 5000);
  if (template.includes("{status}")) vars.status = pick(HTTP_STATUS);
  if (template.includes("{clientId}")) vars.clientId = `client-${shortId()}`;
  if (template.includes("{service}")) vars.service = pick(SERVICE_NAMES);
  if (template.includes("{attempt}")) vars.attempt = randInt(1, 3);
  if (template.includes("{domain}")) vars.domain = `${pick(SERVICE_NAMES)}.internal`;
  if (template.includes("{percent}")) vars.percent = randInt(40, 98);
  if (template.includes("{active}")) vars.active = randInt(10, 200);
  if (template.includes("{max}")) vars.max = 256;
  if (template.includes("{userId}")) vars.userId = `usr-${shortId()}`;
  if (template.includes("{email}")) vars.email = `user${randInt(1, 9999)}@example.com`;
  if (template.includes("{sessionId}")) vars.sessionId = uuid();
  if (template.includes("{ttl}")) vars.ttl = pick([300, 900, 1800, 3600, 86400]);
  if (template.includes("{field}")) vars.field = pick(["name", "email", "avatar", "preferences"]);
  if (template.includes("{count}")) vars.count = randInt(1, 10);
  if (template.includes("{result}"))
    vars.result = pick(["succeeded", "failed", "denied", "granted", "HIT", "MISS"]);
  if (template.includes("{permission}"))
    vars.permission = pick(["read:users", "write:orders", "admin:system"]);
  if (template.includes("{orderId}")) vars.orderId = `ord-${shortId()}`;
  if (template.includes("{amount}")) vars.amount = `$${(randInt(500, 50000) / 100).toFixed(2)}`;
  if (template.includes("{provider}")) vars.provider = pick(PROVIDERS);
  if (template.includes("{reason}"))
    vars.reason = pick(["insufficient_funds", "card_declined", "timeout", "success", "duplicate"]);
  if (template.includes("{quantity}")) vars.quantity = randInt(1, 20);
  if (template.includes("{sku}")) vars.sku = `SKU-${randInt(1000, 9999)}`;
  if (template.includes("{requested}")) vars.requested = randInt(5, 50);
  if (template.includes("{available}")) vars.available = randInt(0, 4);
  if (template.includes("{from}"))
    vars.from = pick(["pending", "processing", "shipped", "delivered"]);
  if (template.includes("{to}"))
    vars.to = pick(["processing", "shipped", "delivered", "cancelled"]);
  if (template.includes("{carrier}")) vars.carrier = pick(CARRIERS);
  if (template.includes("{query}"))
    vars.query = `SELECT * FROM ${pick(DB_TABLES)} WHERE id = '${shortId()}'`;
  if (template.includes("{idle}")) vars.idle = randInt(5, 50);
  if (template.includes("{waiting}")) vars.waiting = randInt(0, 10);
  if (template.includes("{txId}")) vars.txId = `tx-${shortId()}`;
  if (template.includes("{txId1}")) vars.txId1 = `tx-${shortId()}`;
  if (template.includes("{txId2}")) vars.txId2 = `tx-${shortId()}`;
  if (template.includes("{tables}")) vars.tables = randInt(1, 5);
  if (template.includes("{rows}")) vars.rows = randInt(1, 100000);
  if (template.includes("{table}")) vars.table = pick(DB_TABLES);
  if (template.includes("{index}")) vars.index = `idx_${pick(["id", "created_at", "user_id"])}`;
  if (template.includes("{lag}")) vars.lag = randInt(10, 5000);
  if (template.includes("{replica}")) vars.replica = `replica-${randInt(1, 3)}`;
  if (template.includes("{key}")) vars.key = `${pick(DB_TABLES)}:${shortId()}`;
  if (template.includes("{bytes}")) vars.bytes = randInt(1024, 1048576);
  if (template.includes("{ratio}")) vars.ratio = (mulberry32() * 30 + 5).toFixed(1);
  if (template.includes("{window}")) vars.window = pick([60, 300, 900]);
  if (template.includes("{used}")) vars.used = randInt(512, 3800);
  if (template.includes("{peer}")) vars.peer = `cache-${randInt(1, 5)}`;
  if (template.includes("{delta}")) vars.delta = randInt(100, 50000);
  if (template.includes("{topic}")) vars.topic = pick(TOPICS);
  if (template.includes("{partition}")) vars.partition = randInt(0, 15);
  if (template.includes("{offset}")) vars.offset = randInt(100000, 9999999);
  if (template.includes("{group}"))
    vars.group = `cg-${pick(["orders", "notifications", "analytics"])}`;
  if (template.includes("{msgId}")) vars.msgId = uuid();
  if (template.includes("{retries}")) vars.retries = randInt(3, 10);
  if (template.includes("{partitions}")) vars.partitions = `${randInt(0, 3)},${randInt(4, 7)}`;
  if (template.includes("{consumerId}")) vars.consumerId = `consumer-${shortId()}`;
  return vars;
}

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

// ── Structured (KVList) Body Generator ───────────────────────────────

function generateStructuredBody(_service, severity) {
  const method = pick(HTTP_METHODS);
  const path = pick(HTTP_PATHS);
  const status = pick(HTTP_STATUS);
  const duration = randInt(1, 5000);

  const body = {
    msg:
      severity === "ERROR"
        ? pick(["Connection refused", "Timeout exceeded", "Internal server error", "OOM killed"])
        : `${method} ${path} ${status} ${duration}ms`,
    req: { method, url: path, user_id: `usr-${shortId()}`, request_id: uuid() },
    res: { status, duration_ms: duration, bytes: randInt(100, 50000) },
  };

  if (severity === "ERROR" || severity === "FATAL") {
    body.error = {
      type: pick(["TimeoutError", "ConnectionError", "ValidationError", "AuthError"]),
      message: pick([
        "deadline exceeded",
        "connection reset by peer",
        "invalid input",
        "token expired",
      ]),
      stack: `at ${pick(SERVICE_NAMES)}.handler (${pick(SERVICE_NAMES)}.ts:${randInt(10, 500)}:${randInt(1, 40)})`,
    };
  }

  return body;
}

// ── Trace Correlation ────────────────────────────────────────────────

function generateTraceContext() {
  if (mulberry32() < 0.7) {
    const traceId = new Uint8Array(16);
    const spanId = new Uint8Array(8);
    for (let i = 0; i < 16; i++) traceId[i] = Math.floor(mulberry32() * 256);
    for (let i = 0; i < 8; i++) spanId[i] = Math.floor(mulberry32() * 256);
    return { traceId, spanId };
  }
  return {};
}

// ── Main Generator ───────────────────────────────────────────────────

/**
 * Generate a batch of realistic log records.
 * @param {object} opts
 * @param {number} opts.count - Number of logs to generate
 * @param {number} opts.durationMinutes - Time span of the dataset
 * @param {number} [opts.seed] - Random seed (default 42)
 * @param {(progress: number) => void} [opts.onProgress] - Progress callback (0-1)
 * @returns {{ records: Array, stats: object }}
 */
export function generateLogs(opts) {
  const { count, durationMinutes, seed = 42, onProgress } = opts;
  _seed = seed;

  const baseTime = Date.now() - durationMinutes * 60 * 1000;
  const nsPerMs = 1_000_000n;
  const durationNs = BigInt(durationMinutes) * 60n * 1000n * nsPerMs;

  const records = [];
  const stats = {
    byService: {},
    bySeverity: {},
    bodyTemplated: 0,
    bodyKvlist: 0,
    bodyFreetext: 0,
    totalRecords: 0,
  };

  const BATCH_SIZE = 5000;
  let reported = 0;

  for (let i = 0; i < count; i++) {
    const serviceName = pick(SERVICE_NAMES);
    const serviceDef = SERVICES[serviceName];
    const severity = weightedPick(serviceDef.severityWeights);
    const severityNumber = SEVERITY_LEVELS[severity];

    // Time: uniform distribution across the window with some clustering
    const progressFraction = i / count;
    const jitter = (mulberry32() - 0.5) * 0.01;
    const timeFrac = Math.max(0, Math.min(1, progressFraction + jitter));
    const timeUnixNano =
      BigInt(baseTime) * nsPerMs + BigInt(Math.floor(Number(durationNs) * timeFrac));

    // Decide body shape: 61% templated, 39% structured, <1% freetext
    const bodyRoll = mulberry32();
    let body;
    let bodyKind;

    if (bodyRoll < 0.61) {
      // Templated text body
      const template = pick(serviceDef.templates);
      const vars = generateTemplateVars(template, serviceName);
      body = fillTemplate(template, vars);
      bodyKind = "templated";
      stats.bodyTemplated++;
    } else if (bodyRoll < 0.995) {
      // Structured KVList body
      body = generateStructuredBody(serviceName, severity);
      bodyKind = "kvlist";
      stats.bodyKvlist++;
    } else {
      // Free-text (rare)
      body = `[${severity}] Unstructured log event at ${new Date(Number(timeUnixNano / nsPerMs)).toISOString()} — ${uuid()}`;
      bodyKind = "freetext";
      stats.bodyFreetext++;
    }

    // Attributes
    const attributes = [
      { key: "service.name", value: serviceName },
      { key: "log.source", value: bodyKind },
    ];
    if (severity === "ERROR" || severity === "FATAL") {
      attributes.push({ key: "error", value: "true" });
    }
    if (mulberry32() < 0.3) {
      attributes.push({ key: "http.method", value: pick(HTTP_METHODS) });
      attributes.push({ key: "http.status_code", value: String(pick(HTTP_STATUS)) });
    }
    if (mulberry32() < 0.2) {
      attributes.push({
        key: "deployment.environment",
        value: pick(["production", "staging", "canary"]),
      });
    }

    const { traceId, spanId } = generateTraceContext();

    const record = {
      timeUnixNano,
      severityNumber,
      severityText: severity,
      body,
      attributes,
      traceId,
      spanId,
    };

    records.push(record);

    // Stats
    stats.byService[serviceName] = (stats.byService[serviceName] || 0) + 1;
    stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
    stats.totalRecords++;

    // Progress callback every BATCH_SIZE records
    if (onProgress && i - reported >= BATCH_SIZE) {
      reported = i;
      onProgress(i / count);
    }
  }

  if (onProgress) onProgress(1);

  return { records, stats };
}

/**
 * Streaming generator — yields batches for incremental ingest.
 * @param {object} opts
 * @param {number} opts.count
 * @param {number} opts.durationMinutes
 * @param {number} [opts.batchSize]
 * @param {number} [opts.seed]
 * @yields {{ batch: Array, progress: number }}
 */
export function* generateLogBatches(opts) {
  const { count, durationMinutes, batchSize = 2048, seed = 42 } = opts;
  _seed = seed;

  const baseTime = Date.now() - durationMinutes * 60 * 1000;
  const nsPerMs = 1_000_000n;
  const durationNs = BigInt(durationMinutes) * 60n * 1000n * nsPerMs;
  let batch = [];

  for (let i = 0; i < count; i++) {
    const serviceName = pick(SERVICE_NAMES);
    const serviceDef = SERVICES[serviceName];
    const severity = weightedPick(serviceDef.severityWeights);
    const severityNumber = SEVERITY_LEVELS[severity];

    const progressFraction = i / count;
    const jitter = (mulberry32() - 0.5) * 0.01;
    const timeFrac = Math.max(0, Math.min(1, progressFraction + jitter));
    const timeUnixNano =
      BigInt(baseTime) * nsPerMs + BigInt(Math.floor(Number(durationNs) * timeFrac));

    const bodyRoll = mulberry32();
    let body;
    if (bodyRoll < 0.61) {
      const template = pick(serviceDef.templates);
      const vars = generateTemplateVars(template, serviceName);
      body = fillTemplate(template, vars);
    } else if (bodyRoll < 0.995) {
      body = generateStructuredBody(serviceName, severity);
    } else {
      body = `[${severity}] Unstructured log event at ${new Date(Number(timeUnixNano / nsPerMs)).toISOString()} — ${uuid()}`;
    }

    const attributes = [{ key: "service.name", value: serviceName }];
    if (severity === "ERROR" || severity === "FATAL") {
      attributes.push({ key: "error", value: "true" });
    }

    const { traceId, spanId } = generateTraceContext();

    batch.push({
      timeUnixNano,
      severityNumber,
      severityText: severity,
      body,
      attributes,
      traceId,
      spanId,
    });

    if (batch.length >= batchSize) {
      yield { batch, progress: i / count };
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield { batch, progress: 1 };
  }
}
