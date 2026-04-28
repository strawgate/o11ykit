/**
 * Synthetic corpus generators for comprehensive benchmarking.
 *
 * Covers the major log workload shapes seen in production:
 *   - Templated syslog (Linux/HDFS-like)
 *   - Structured JSON (Pino/Winston-like HTTP service logs)
 *   - High-cardinality (UUIDs, trace IDs, request IDs in every record)
 *   - Cloud-native (Kubernetes events, Docker container logs)
 *   - Mixed (realistic service with all body types)
 *
 * Each generator produces LogRecord[] suitable for direct ingest into
 * LogStore. Sizes: 1K, 10K, 100K, 1M (configurable).
 */

import type { AnyValue, LogRecord } from "../dist/index.js";

// ── Random helpers ───────────────────────────────────────────────────

let _seed = 42;
function setSeed(s: number) {
  _seed = s;
}
function rand(): number {
  let t = (_seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}
function uuid(): string {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) s += "-";
    s += h[Math.floor(rand() * 16)];
  }
  return s;
}
function shortHex(n: number): string {
  return Math.floor(rand() * (16 ** n))
    .toString(16)
    .padStart(n, "0");
}

// ── Severity distribution ────────────────────────────────────────────

const SEVERITY_WEIGHTS = [
  // [severityNumber, severityText, weight]
  [1, "TRACE", 3],
  [5, "DEBUG", 12],
  [9, "INFO", 60],
  [13, "WARN", 15],
  [17, "ERROR", 8],
  [21, "FATAL", 2],
] as const;

function randomSeverity(): { severityNumber: number; severityText: string } {
  const total = SEVERITY_WEIGHTS.reduce((s, [, , w]) => s + w, 0);
  let r = rand() * total;
  for (const [num, text, w] of SEVERITY_WEIGHTS) {
    r -= w;
    if (r <= 0) return { severityNumber: num, severityText: text };
  }
  return { severityNumber: 9, severityText: "INFO" };
}

// ── Corpus: Templated Syslog ─────────────────────────────────────────

const SYSLOG_TEMPLATES = [
  "sshd[{pid}]: Accepted publickey for {user} from {ip} port {port} ssh2: RSA SHA256:{hash}",
  "sshd[{pid}]: pam_unix(sshd:session): session opened for user {user} by (uid=0)",
  "sshd[{pid}]: Disconnected from {ip} port {port}",
  "kernel: [{uptime}] eth0: link up at {speed} Mbps, full duplex",
  "kernel: [{uptime}] Out of memory: Kill process {pid} ({process}) score {score}",
  "systemd[1]: Started {service}.service - {description}.",
  "systemd[1]: Stopping {service}.service...",
  "systemd[1]: {service}.service: Main process exited, code=exited, status={code}",
  "CRON[{pid}]: (root) CMD ({command})",
  "sudo: {user} : TTY=pts/{tty} ; PWD={path} ; USER=root ; COMMAND={command}",
  "dhclient[{pid}]: DHCPREQUEST on {iface} to {ip} port 67",
  "kernel: [{uptime}] audit: backlog limit exceeded",
  "sshd[{pid}]: Failed password for invalid user {user} from {ip} port {port} ssh2",
  "kernel: [{uptime}] TCP: request_sock_TCP: Possible SYN flooding on port {port}. Sending cookies.",
  "rsyslogd: [{uptime}] action '{action}' resumed (module '{module}')",
];

const USERS = ["root", "admin", "deploy", "www-data", "postgres", "nginx", "app"];
const SERVICES = ["nginx", "postgresql", "redis", "docker", "kubelet", "containerd", "etcd"];
const COMMANDS = ["/usr/sbin/logrotate /etc/logrotate.conf", "run-parts /etc/cron.hourly", "/usr/bin/apt-get update -q"];

function fillSyslogTemplate(tmpl: string): string {
  return tmpl
    .replace(/\{pid\}/g, () => String(randInt(1000, 65535)))
    .replace(/\{user\}/g, () => pick(USERS))
    .replace(/\{ip\}/g, () => `${randInt(10, 192)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`)
    .replace(/\{port\}/g, () => String(randInt(1024, 65535)))
    .replace(/\{hash\}/g, () => shortHex(40))
    .replace(/\{uptime\}/g, () => `${randInt(1, 99999)}.${randInt(100, 999)}`)
    .replace(/\{speed\}/g, () => pick(["100", "1000", "10000"]))
    .replace(/\{process\}/g, () => pick(["java", "python3", "node", "postgres", "redis-server"]))
    .replace(/\{score\}/g, () => String(randInt(100, 999)))
    .replace(/\{service\}/g, () => pick(SERVICES))
    .replace(/\{description\}/g, () => pick(["HTTP server", "Database", "Cache", "Message queue"]))
    .replace(/\{code\}/g, () => String(pick([0, 1, 2, 137, 143])))
    .replace(/\{command\}/g, () => pick(COMMANDS))
    .replace(/\{tty\}/g, () => String(randInt(0, 9)))
    .replace(/\{path\}/g, () => pick(["/root", "/home/deploy", "/var/log"]))
    .replace(/\{iface\}/g, () => pick(["eth0", "ens5", "wlan0"]))
    .replace(/\{action\}/g, () => pick(["action-1-builtin:omfile", "action-3-builtin:ommysql"]))
    .replace(/\{module\}/g, () => pick(["builtin:omfile", "builtin:ommysql"]));
}

export function generateSyslogCorpus(count: number, seed = 42): LogRecord[] {
  setSeed(seed);
  const records: LogRecord[] = [];
  const baseNs = BigInt(Date.now()) * 1_000_000n;
  for (let i = 0; i < count; i++) {
    const { severityNumber, severityText } = randomSeverity();
    records.push({
      timeUnixNano: baseNs + BigInt(i) * 1_000_000_000n,
      severityNumber,
      severityText,
      body: fillSyslogTemplate(pick(SYSLOG_TEMPLATES)),
      attributes: [{ key: "host", value: `server-${randInt(1, 20)}` }],
    });
  }
  return records;
}

// ── Corpus: Structured JSON (HTTP service) ───────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const HTTP_PATHS = [
  "/api/v2/users", "/api/v2/orders", "/api/v2/products",
  "/api/v2/checkout", "/api/v2/search", "/health", "/metrics",
];
const HTTP_STATUS = [200, 200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503];

export function generateStructuredCorpus(count: number, seed = 42): LogRecord[] {
  setSeed(seed);
  const records: LogRecord[] = [];
  const baseNs = BigInt(Date.now()) * 1_000_000n;
  for (let i = 0; i < count; i++) {
    const { severityNumber, severityText } = randomSeverity();
    const method = pick(HTTP_METHODS);
    const path = pick(HTTP_PATHS);
    const status = pick(HTTP_STATUS);
    const duration = randInt(1, 5000);

    const body: { [key: string]: AnyValue } = {
      msg: `${method} ${path} ${status} ${duration}ms`,
      level: severityText.toLowerCase(),
      req: {
        method,
        url: path,
        headers: { "x-request-id": uuid(), "user-agent": "Mozilla/5.0" },
        user_id: `usr-${shortHex(8)}`,
      },
      res: { status, duration_ms: duration, bytes: randInt(100, 50000) },
      time: Date.now() + i * 1000,
    };

    if (severityNumber >= 17) {
      body.error = {
        type: pick(["TimeoutError", "ConnectionError", "ValidationError"]),
        message: pick(["deadline exceeded", "connection reset", "invalid input"]),
      };
    }

    records.push({
      timeUnixNano: baseNs + BigInt(i) * 1_000_000_000n,
      severityNumber,
      severityText,
      body,
      attributes: [
        { key: "service.name", value: pick(["api-gateway", "user-service", "order-service"]) },
        { key: "deployment.environment", value: pick(["production", "staging"]) },
      ],
    });
  }
  return records;
}

// ── Corpus: High-Cardinality ─────────────────────────────────────────

const HC_TEMPLATES = [
  "Processing request {requestId} for user {userId} trace={traceId}",
  "Cache lookup key={cacheKey} result={result} latency={latency}ms",
  "Database query tx={txId} table={table} rows={rows} duration={duration}ms",
  "Message consumed topic={topic} partition={partition} offset={offset} key={msgKey}",
  "Span completed spanId={spanId} traceId={traceId} duration={duration}ns",
];

export function generateHighCardinalityCorpus(count: number, seed = 42): LogRecord[] {
  setSeed(seed);
  const records: LogRecord[] = [];
  const baseNs = BigInt(Date.now()) * 1_000_000n;
  for (let i = 0; i < count; i++) {
    const { severityNumber, severityText } = randomSeverity();
    const tmpl = pick(HC_TEMPLATES);
    const body = tmpl
      .replace("{requestId}", uuid())
      .replace("{userId}", `usr-${shortHex(8)}`)
      .replace("{traceId}", shortHex(32))
      .replace("{spanId}", shortHex(16))
      .replace("{cacheKey}", `${pick(["user", "session", "product"])}:${shortHex(8)}`)
      .replace("{result}", pick(["HIT", "MISS"]))
      .replace("{latency}", String(randInt(1, 500)))
      .replace("{txId}", `tx-${shortHex(8)}`)
      .replace("{table}", pick(["users", "orders", "products", "sessions"]))
      .replace("{rows}", String(randInt(1, 100000)))
      .replace("{duration}", String(randInt(1, 10000)))
      .replace("{topic}", pick(["orders.created", "payments.processed", "events.raw"]))
      .replace("{partition}", String(randInt(0, 15)))
      .replace("{offset}", String(randInt(100000, 9999999)))
      .replace("{msgKey}", shortHex(16));

    const traceId = new Uint8Array(16);
    const spanId = new Uint8Array(8);
    for (let j = 0; j < 16; j++) traceId[j] = Math.floor(rand() * 256);
    for (let j = 0; j < 8; j++) spanId[j] = Math.floor(rand() * 256);

    records.push({
      timeUnixNano: baseNs + BigInt(i) * 1_000_000_000n,
      severityNumber,
      severityText,
      body,
      attributes: [
        { key: "service.name", value: pick(["gateway", "processor", "indexer"]) },
        { key: "request.id", value: uuid() },
      ],
      traceId,
      spanId,
    });
  }
  return records;
}

// ── Corpus: Cloud-Native (K8s/Docker) ────────────────────────────────

const K8S_TEMPLATES = [
  'I{timestamp} {pid} {file}:{line}] "Trying to schedule pod {namespace}/{pod}"',
  'I{timestamp} {pid} {file}:{line}] "Successfully assigned {namespace}/{pod} to {node}"',
  'W{timestamp} {pid} {file}:{line}] "FailedScheduling: {reason}"',
  'E{timestamp} {pid} {file}:{line}] "Error syncing pod {podId}: {error}"',
  "time=\"{iso}\" level={level} msg=\"{msg}\" container={container} namespace={namespace}",
  "{iso} stdout F {json_line}",
  "level={level} ts={iso} caller={caller} msg=\"{msg}\" component={component}",
];
const K8S_NAMESPACES = ["default", "kube-system", "monitoring", "production", "staging"];
const K8S_NODES = ["node-01", "node-02", "node-03", "node-04"];
const K8S_PODS = ["api-deploy-7b5c4", "worker-deploy-3f2a1", "redis-0", "postgres-0", "nginx-ingress-abc12"];
const K8S_ERRORS = ["CrashLoopBackOff", "OOMKilled", "ImagePullBackOff", "ErrImagePull", "ContainerCreating"];

export function generateCloudNativeCorpus(count: number, seed = 42): LogRecord[] {
  setSeed(seed);
  const records: LogRecord[] = [];
  const baseNs = BigInt(Date.now()) * 1_000_000n;
  for (let i = 0; i < count; i++) {
    const { severityNumber, severityText } = randomSeverity();
    const tmpl = pick(K8S_TEMPLATES);
    const body = tmpl
      .replace("{timestamp}", `${randInt(0, 1231)}${randInt(10, 12)}${randInt(10, 28)} ${randInt(10, 23)}:${randInt(10, 59)}:${randInt(10, 59)}.${randInt(100, 999)}`)
      .replace("{pid}", String(randInt(1, 9)))
      .replace("{file}", pick(["scheduler.go", "kubelet.go", "controller.go", "pod.go"]))
      .replace("{line}", String(randInt(100, 999)))
      .replace("{namespace}", pick(K8S_NAMESPACES))
      .replace("{pod}", pick(K8S_PODS))
      .replace("{node}", pick(K8S_NODES))
      .replace("{reason}", pick(K8S_ERRORS))
      .replace("{podId}", shortHex(12))
      .replace("{error}", pick(["context deadline exceeded", "connection refused", "no such container"]))
      .replace("{iso}", new Date(Date.now() - randInt(0, 86400000)).toISOString())
      .replace("{level}", severityText.toLowerCase())
      .replace("{msg}", pick(["container started", "health check failed", "pulling image", "sync complete"]))
      .replace("{container}", `${pick(["api", "sidecar", "init"])}`)
      .replace("{caller}", `${pick(["main.go", "server.go", "handler.go"])}:${randInt(10, 500)}`)
      .replace("{component}", pick(["kube-scheduler", "kube-controller-manager", "kubelet"]))
      .replace("{json_line}", JSON.stringify({ ts: Date.now(), msg: pick(["request handled", "query executed"]) }));

    records.push({
      timeUnixNano: baseNs + BigInt(i) * 1_000_000_000n,
      severityNumber,
      severityText,
      body,
      attributes: [
        { key: "k8s.namespace.name", value: pick(K8S_NAMESPACES) },
        { key: "k8s.pod.name", value: pick(K8S_PODS) },
        { key: "k8s.node.name", value: pick(K8S_NODES) },
      ],
    });
  }
  return records;
}

// ── Corpus: Mixed (realistic service) ────────────────────────────────

export function generateMixedCorpus(count: number, seed = 42): LogRecord[] {
  setSeed(seed);
  const records: LogRecord[] = [];
  const baseNs = BigInt(Date.now()) * 1_000_000n;

  for (let i = 0; i < count; i++) {
    const roll = rand();
    let record: LogRecord;

    if (roll < 0.4) {
      // 40% syslog-style templated
      const [r] = generateSyslogCorpus(1, _seed);
      record = r!;
      _seed += 7;
    } else if (roll < 0.75) {
      // 35% structured JSON
      const [r] = generateStructuredCorpus(1, _seed);
      record = r!;
      _seed += 7;
    } else if (roll < 0.9) {
      // 15% high-cardinality
      const [r] = generateHighCardinalityCorpus(1, _seed);
      record = r!;
      _seed += 7;
    } else {
      // 10% cloud-native
      const [r] = generateCloudNativeCorpus(1, _seed);
      record = r!;
      _seed += 7;
    }

    // Override timestamp to maintain ordering
    record!.timeUnixNano = baseNs + BigInt(i) * 1_000_000_000n;
    records.push(record!);
  }
  return records;
}

// ── Corpus Sizes ─────────────────────────────────────────────────────

export type CorpusSize = "1k" | "10k" | "100k" | "1m";

export const CORPUS_SIZES: Record<CorpusSize, number> = {
  "1k": 1_000,
  "10k": 10_000,
  "100k": 100_000,
  "1m": 1_000_000,
};

export type SyntheticCorpusType =
  | "syslog"
  | "structured"
  | "high-cardinality"
  | "cloud-native"
  | "mixed";

export const CORPUS_GENERATORS: Record<SyntheticCorpusType, (count: number, seed?: number) => LogRecord[]> = {
  "syslog": generateSyslogCorpus,
  "structured": generateStructuredCorpus,
  "high-cardinality": generateHighCardinalityCorpus,
  "cloud-native": generateCloudNativeCorpus,
  "mixed": generateMixedCorpus,
};
