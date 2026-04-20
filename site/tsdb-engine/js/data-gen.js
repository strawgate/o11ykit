// ── Data Generators ──────────────────────────────────────────────────

export const REGIONS = ["us-east", "us-west", "eu-west", "ap-south", "ap-east"];
export const INSTANCES = [
  "web-01",
  "web-02",
  "web-03",
  "api-01",
  "api-02",
  "worker-01",
  "worker-02",
  "cache-01",
  "db-01",
  "db-02",
];
export const METRICS = ["http_requests_total", "cpu_usage_percent", "memory_usage_bytes"];

export function generateValue(pattern, i, seriesIdx, _total) {
  const phase = seriesIdx * 0.7;
  switch (pattern) {
    case "sine":
      return (
        100 +
        Math.sin(i / 50 + phase) * 40 +
        Math.sin(i / 200 + phase) * 20 +
        (Math.random() - 0.5) * 8
      );
    case "sawtooth":
      return ((i + seriesIdx * 100) % 200) + Math.random() * 5;
    case "random-walk": {
      const seed = seriesIdx * 7919 + 1;
      const v =
        50 +
        seriesIdx * 10 +
        Math.sin(i * 0.01 + seed) * 30 +
        Math.sin(i * 0.003 + seed * 1.7) * 20 +
        Math.cos(i * 0.0007 + seed * 2.3) * 15;
      return Math.max(0, v);
    }
    case "spiky": {
      const base = 20 + seriesIdx * 5;
      const spike = i % 100 < 5 ? 200 + Math.random() * 100 : 0;
      return base + Math.random() * 10 + spike;
    }
    case "constant":
      return 42.0 + seriesIdx * 0.001;
    default:
      return Math.random() * 100;
  }
}

// ── Pre-canned Scenarios ──────────────────────────────────────────────

export const SCENARIOS = [
  {
    id: "ecommerce",
    name: "E-Commerce Platform",
    emoji: "🛒",
    description: "Web traffic, checkout latency, cart events, and active users across regions.",
    metrics: [
      { name: "http_requests_total", pattern: "sine" },
      { name: "checkout_latency_ms", pattern: "spiky" },
      { name: "cart_abandonment_rate", pattern: "random-walk" },
      { name: "active_users", pattern: "sine" },
    ],
    labelGroups: [
      { region: "us-east", job: "frontend" },
      { region: "us-west", job: "frontend" },
      { region: "eu-west", job: "frontend" },
      { region: "us-east", job: "api" },
      { region: "us-west", job: "api" },
    ],
    numPoints: 5000,
    intervalMs: 10000,
  },
  {
    id: "kubernetes",
    name: "Kubernetes Cluster",
    emoji: "☸️",
    description: "CPU, memory, pod restarts, and network I/O across namespaces and nodes.",
    metrics: [
      { name: "cpu_usage_cores", pattern: "random-walk" },
      { name: "memory_usage_bytes", pattern: "sawtooth" },
      { name: "pod_restart_count", pattern: "spiky" },
      { name: "network_bytes_sent", pattern: "random-walk" },
    ],
    labelGroups: [
      { namespace: "prod", node: "node-1" },
      { namespace: "prod", node: "node-2" },
      { namespace: "prod", node: "node-3" },
      { namespace: "staging", node: "node-1" },
      { namespace: "staging", node: "node-2" },
      { namespace: "default", node: "node-1" },
    ],
    numPoints: 5000,
    intervalMs: 15000,
  },
  {
    id: "iot",
    name: "IoT Sensor Network",
    emoji: "📡",
    description: "Temperature, humidity, battery voltage, and signal strength from remote sensors.",
    metrics: [
      { name: "temperature_celsius", pattern: "sine" },
      { name: "humidity_percent", pattern: "sine" },
      { name: "battery_voltage", pattern: "sawtooth" },
      { name: "signal_strength_dbm", pattern: "random-walk" },
    ],
    labelGroups: [
      { zone: "warehouse", device: "sensor-01" },
      { zone: "warehouse", device: "sensor-02" },
      { zone: "outdoor", device: "sensor-03" },
      { zone: "outdoor", device: "sensor-04" },
      { zone: "office", device: "sensor-05" },
    ],
    numPoints: 3000,
    intervalMs: 60000,
  },
  {
    id: "database",
    name: "Database Server Farm",
    emoji: "🗄️",
    description: "Query latency, active connections, cache hit ratio, and replication lag.",
    metrics: [
      { name: "query_latency_p99_ms", pattern: "spiky" },
      { name: "active_connections", pattern: "random-walk" },
      { name: "cache_hit_ratio", pattern: "constant" },
      { name: "replication_lag_ms", pattern: "sawtooth" },
    ],
    labelGroups: [
      { host: "db-primary", db: "users" },
      { host: "replica-1", db: "users" },
      { host: "replica-2", db: "users" },
      { host: "db-primary", db: "orders" },
      { host: "replica-1", db: "orders" },
    ],
    numPoints: 10000,
    intervalMs: 10000,
  },
];

export function generateScenarioData(scenario) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const intervalNs = BigInt(scenario.intervalMs) * 1_000_000n;
  const { numPoints, metrics, labelGroups } = scenario;
  const startT = now - BigInt(numPoints) * intervalNs;

  const series = [];
  let seriesIdx = 0;
  for (const m of metrics) {
    for (const lg of labelGroups) {
      const labels = new Map([["__name__", m.name], ...Object.entries(lg)]);
      const timestamps = new BigInt64Array(numPoints);
      const values = new Float64Array(numPoints);
      for (let i = 0; i < numPoints; i++) {
        timestamps[i] = startT + BigInt(i) * intervalNs;
        values[i] = generateValue(m.pattern, i, seriesIdx, numPoints);
      }
      series.push({ labels, timestamps, values });
      seriesIdx++;
    }
  }
  return series;
}
