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

// Label dimensions are cross-producted to create label groups automatically.
// E.g. { region: ['a','b'], job: ['x','y'] } → 4 label groups.

export const SCENARIOS = [
  {
    id: 'ecommerce',
    name: 'E-Commerce Platform',
    emoji: '🛒',
    description: 'Web traffic, latency percentiles, error rates, and checkout flow across a global fleet of services.',
    metrics: [
      { name: 'http_requests_total', pattern: 'sine' },
      { name: 'request_latency_p99_ms', pattern: 'spiky' },
      { name: 'error_rate', pattern: 'random-walk' },
      { name: 'cart_events_total', pattern: 'sine' },
      { name: 'active_sessions', pattern: 'random-walk' },
      { name: 'checkout_total', pattern: 'sawtooth' },
    ],
    labelDimensions: {
      region: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'],
      service: ['web', 'api', 'checkout', 'search', 'cart', 'auth', 'cdn', 'payments'],
      endpoint: ['/home', '/search', '/cart', '/checkout'],
    },
    numPoints: 7500,
    intervalMs: 10000,
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes Cluster',
    emoji: '☸️',
    description: 'CPU, memory, pod restarts, and network I/O across namespaces, nodes, and pods.',
    metrics: [
      { name: 'cpu_usage_cores', pattern: 'random-walk' },
      { name: 'memory_usage_bytes', pattern: 'sawtooth' },
      { name: 'pod_restart_total', pattern: 'spiky' },
      { name: 'network_rx_bytes', pattern: 'random-walk' },
      { name: 'network_tx_bytes', pattern: 'random-walk' },
    ],
    labelDimensions: {
      namespace: ['prod', 'staging', 'monitoring', 'kube-system'],
      node: ['node-01', 'node-02', 'node-03', 'node-04', 'node-05',
             'node-06', 'node-07', 'node-08', 'node-09', 'node-10',
             'node-11', 'node-12'],
      pod: ['web', 'api', 'worker', 'cache', 'queue', 'cron'],
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
  const values = keys.map(k => dims[k]);
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
  const labelCombinations = keys.length === 0 ? 1
    : keys.reduce((acc, k) => acc * dims[k].length, 1);
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
      const labels = new Map([['__name__', m.name], ...Object.entries(lg)]);
      const timestamps = new BigInt64Array(numPoints);
      const values = new Float64Array(numPoints);
      for (let i = 0; i < numPoints; i++) {
        timestamps[i] = startT + BigInt(i) * intervalNs;
        values[i] = generateValue(m.pattern, i, seriesIdx, numPoints);
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
