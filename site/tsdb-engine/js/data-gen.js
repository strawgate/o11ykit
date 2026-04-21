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

/**
 * Generate a single value for a pattern.
 * @param {string} pattern - one of sine, sawtooth, random-walk, spiky, constant
 * @param {number} i - sample index
 * @param {number} seriesIdx - series index (for phase offset)
 * @param {number} [_total] - total samples (unused)
 * @param {number} [decimals] - decimal places to round to.  undefined = full f64 precision
 */
export function generateValue(pattern, i, seriesIdx, _total, decimals) {
  const phase = seriesIdx * 0.7;
  let v;
  switch (pattern) {
    case "sine":
      v =
        100 +
        Math.sin(i / 50 + phase) * 40 +
        Math.sin(i / 200 + phase) * 20 +
        (Math.random() - 0.5) * 8;
      break;
    case "sawtooth":
      v = ((i + seriesIdx * 100) % 200) + Math.random() * 5;
      break;
    case "random-walk": {
      const seed = seriesIdx * 7919 + 1;
      v = Math.max(
        0,
        50 +
          seriesIdx * 10 +
          Math.sin(i * 0.01 + seed) * 30 +
          Math.sin(i * 0.003 + seed * 1.7) * 20 +
          Math.cos(i * 0.0007 + seed * 2.3) * 15
      );
      break;
    }
    case "spiky": {
      const base = 20 + seriesIdx * 5;
      const spike = i % 100 < 5 ? 200 + Math.random() * 100 : 0;
      v = base + Math.random() * 10 + spike;
      break;
    }
    case "constant":
      v = 42.0 + seriesIdx * 0.001;
      break;
    default:
      v = Math.random() * 100;
  }
  if (decimals !== undefined) {
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  }
  return v;
}

// ── Pre-canned Scenarios ──────────────────────────────────────────────

// Label dimensions are cross-producted to create label groups automatically.
// E.g. { region: ['a','b'], job: ['x','y'] } → 4 label groups.

export const SCENARIOS = [
  {
    id: "ecommerce",
    name: "E-Commerce Platform",
    emoji: "🛒",
    description:
      "Web traffic, latency percentiles, error rates, and checkout flow across a global fleet of services.",
    metrics: [
      { name: "http_requests_total", pattern: "sine", decimals: 0 },
      { name: "request_latency_p99_ms", pattern: "spiky", decimals: 1 },
      { name: "error_rate", pattern: "random-walk", decimals: 4 },
      { name: "cart_events_total", pattern: "sine", decimals: 0 },
      { name: "active_sessions", pattern: "random-walk", decimals: 0 },
      { name: "checkout_total", pattern: "sawtooth", decimals: 0 },
    ],
    labelDimensions: {
      region: ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1"],
      service: ["web", "api", "checkout", "search", "cart", "auth", "cdn", "payments"],
      endpoint: ["/home", "/search", "/cart", "/checkout"],
    },
    numPoints: 7500,
    intervalMs: 10000,
  },
  {
    id: "kubernetes",
    name: "Kubernetes Cluster",
    emoji: "☸️",
    description: "CPU, memory, pod restarts, and network I/O across namespaces, nodes, and pods.",
    metrics: [
      { name: "cpu_usage_cores", pattern: "random-walk", decimals: 3 },
      { name: "memory_usage_bytes", pattern: "sawtooth", decimals: 0 },
      { name: "pod_restart_total", pattern: "spiky", decimals: 0 },
      { name: "network_rx_bytes", pattern: "random-walk", decimals: 0 },
      { name: "network_tx_bytes", pattern: "random-walk", decimals: 0 },
    ],
    labelDimensions: {
      namespace: ["prod", "staging", "monitoring", "kube-system"],
      node: [
        "node-01",
        "node-02",
        "node-03",
        "node-04",
        "node-05",
        "node-06",
        "node-07",
        "node-08",
        "node-09",
        "node-10",
        "node-11",
        "node-12",
      ],
      pod: ["web", "api", "worker", "cache", "queue", "cron"],
    },
    numPoints: 6000,
    intervalMs: 15000,
  },
];

// Compute cross-product of label dimensions → flat array of label objects.
function _expandLabelDimensions(dims) {
  const keys = Object.keys(dims);
  if (keys.length === 0) return [{}];
  const result = [];
  const values = keys.map((k) => dims[k]);
  const indices = new Array(keys.length).fill(0);

  for (;;) {
    const group = {};
    for (let d = 0; d < keys.length; d++) group[keys[d]] = values[d][indices[d]];
    result.push(group);

    let carry = keys.length - 1;
    while (carry >= 0) {
      indices[carry]++;
      if (indices[carry] < values[carry].length) break;
      indices[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }
  return result;
}

/** Compute series count for a scenario without generating data. */
export function scenarioSeriesCount(scenario) {
  const dims = scenario.labelDimensions || {};
  const keys = Object.keys(dims);
  const labelCombinations =
    keys.length === 0 ? 1 : keys.reduce((acc, k) => acc * dims[k].length, 1);
  return scenario.metrics.length * labelCombinations;
}

/** Compute total sample count for a scenario. */
export function scenarioSampleCount(scenario) {
  return scenarioSeriesCount(scenario) * scenario.numPoints;
}

export function generateScenarioData(scenario, onProgress) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const intervalNs = BigInt(scenario.intervalMs) * 1_000_000n;
  const { numPoints, metrics } = scenario;
  const labelGroups = _expandLabelDimensions(scenario.labelDimensions || {});
  const startT = now - BigInt(numPoints) * intervalNs;

  const totalSeries = metrics.length * labelGroups.length;
  const series = [];
  let seriesIdx = 0;
  for (const m of metrics) {
    for (const lg of labelGroups) {
      const labels = new Map([["__name__", m.name], ...Object.entries(lg)]);
      const timestamps = new BigInt64Array(numPoints);
      const values = new Float64Array(numPoints);
      for (let i = 0; i < numPoints; i++) {
        timestamps[i] = startT + BigInt(i) * intervalNs;
        values[i] = generateValue(m.pattern, i, seriesIdx, numPoints, m.decimals);
      }
      series.push({ labels, timestamps, values });
      seriesIdx++;
      if (onProgress && seriesIdx % 200 === 0) {
        onProgress(seriesIdx, totalSeries);
      }
    }
  }
  if (onProgress) onProgress(totalSeries, totalSeries);
  return series;
}
