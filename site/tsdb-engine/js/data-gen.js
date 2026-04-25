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
const K8S_REPLICA_MULTIPLIER = 3;
const K8S_REPLICAS_DEFAULT = 3;
const K8S_REPLICAS_FRONTEND = 4;
const K8S_REPLICAS_KUBE_SYSTEM = 2;
const APPROX_BYTES_PER_SAMPLE = 16;

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seedFromMetric(metric, labels, seriesIdx) {
  const labelKey = [...labels.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
  return hashString(`${metric.name}|${seriesIdx}|${labelKey}`);
}

function seededWave(seed, i, speed, amplitude = 1) {
  const phase = (seed % 997) / 31;
  return Math.sin(i * speed + phase) * amplitude;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildKubernetesLabelGroups() {
  const cluster = "prod-us-central-1";
  const namespaces = {
    checkout: ["checkout", "cart", "frontend"],
    payments: ["payments", "ledger"],
    observability: ["otel-collector", "prometheus"],
    "kube-system": ["coredns", "metrics-server"],
  };
  const nodes = [
    "ip-10-0-1-12.ec2.internal",
    "ip-10-0-1-23.ec2.internal",
    "ip-10-0-2-18.ec2.internal",
    "ip-10-0-2-31.ec2.internal",
    "ip-10-0-3-07.ec2.internal",
    "ip-10-0-3-22.ec2.internal",
  ];
  const groups = [];
  let podCounter = 0;
  for (const [namespace, workloads] of Object.entries(namespaces)) {
    for (const workload of workloads) {
      const replicas =
        (namespace === "kube-system"
          ? K8S_REPLICAS_KUBE_SYSTEM
          : workload === "frontend"
            ? K8S_REPLICAS_FRONTEND
            : K8S_REPLICAS_DEFAULT) * K8S_REPLICA_MULTIPLIER;
      for (let replica = 0; replica < replicas; replica++) {
        const suffix = (10000 + podCounter * 97 + replica * 17).toString(36).slice(-5);
        const podName = `${workload}-${suffix}`;
        const containerName = workload;
        const node = nodes[podCounter % nodes.length];
        groups.push({
          "k8s.cluster.name": cluster,
          "k8s.namespace.name": namespace,
          "k8s.node.name": node,
          "k8s.pod.name": podName,
          "k8s.container.name": containerName,
        });
        podCounter++;
      }
    }
  }
  return groups;
}

function expandMetricLabelGroups(baseGroups, extraDims = {}) {
  const extraKeys = Object.keys(extraDims);
  if (extraKeys.length === 0) return baseGroups;
  const extraGroups = _expandLabelDimensions(extraDims);
  const merged = [];
  for (const base of baseGroups) {
    for (const extra of extraGroups) {
      merged.push({ ...base, ...extra });
    }
  }
  return merged;
}

function generateSeriesValues(metric, labels, seriesIdx, numPoints, intervalMs) {
  const seed = seedFromMetric(metric, labels, seriesIdx);
  const values = new Float64Array(numPoints);
  const intervalSec = intervalMs / 1000;
  const namespace = labels.get("k8s.namespace.name") || labels.get("namespace") || "default";
  const direction = labels.get("network.io.direction");

  switch (metric.profile) {
    case "k8s-pod-cpu-usage": {
      const namespaceBase =
        namespace === "checkout" ? 0.45 : namespace === "payments" ? 0.35 : 0.12;
      const workloadBias = (seed % 17) / 100;
      for (let i = 0; i < numPoints; i++) {
        const value =
          namespaceBase +
          workloadBias +
          seededWave(seed, i, 1 / 45, 0.16) +
          seededWave(seed * 3, i, 1 / 160, 0.07) +
          seededWave(seed * 5, i, 1 / 11, 0.015);
        values[i] = clamp(value, 0.02, 2.4);
      }
      return values;
    }
    case "k8s-pod-memory-working-set": {
      const namespaceBaseMiB =
        namespace === "checkout" ? 420 : namespace === "payments" ? 620 : 180;
      const podBiasMiB = seed % 220;
      for (let i = 0; i < numPoints; i++) {
        const mib =
          namespaceBaseMiB +
          podBiasMiB +
          seededWave(seed, i, 1 / 90, 38) +
          seededWave(seed * 7, i, 1 / 260, 20) +
          seededWave(seed * 11, i, 1 / 23, 4);
        values[i] = Math.max(64, mib) * 1024 * 1024;
      }
      return values;
    }
    case "k8s-pod-network-io": {
      let counter = (seed % 5000) * 1024;
      const baseRate =
        (direction === "receive" ? 320_000 : 180_000) +
        (seed % 90_000) +
        (namespace === "checkout" ? 80_000 : 0);
      for (let i = 0; i < numPoints; i++) {
        const rate =
          baseRate *
          (1 + seededWave(seed, i, 1 / 60, 0.28) + seededWave(seed * 13, i, 1 / 11, 0.05));
        counter += Math.max(0, rate) * intervalSec;
        values[i] = Math.round(counter);
      }
      return values;
    }
    case "k8s-container-restart-count": {
      let counter = seed % 3;
      for (let i = 0; i < numPoints; i++) {
        const eventWave =
          seededWave(seed * 17, i, 1 / 700, 1) + seededWave(seed * 19, i, 1 / 170, 0.35);
        if (eventWave > 1.05) counter += 1;
        values[i] = counter;
      }
      return values;
    }
    case "k8s-container-cpu-limit-utilization": {
      const namespaceBase =
        namespace === "checkout" ? 0.58 : namespace === "payments" ? 0.63 : 0.32;
      const podBias = (seed % 21) / 100;
      for (let i = 0; i < numPoints; i++) {
        const value =
          namespaceBase +
          podBias +
          seededWave(seed, i, 1 / 55, 0.18) +
          seededWave(seed * 23, i, 1 / 250, 0.08);
        values[i] = clamp(value, 0.05, 1.15);
      }
      return values;
    }
    default: {
      for (let i = 0; i < numPoints; i++) {
        values[i] = generateValue(metric.pattern, i, seriesIdx, numPoints, metric.decimals);
      }
      return values;
    }
  }
}

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
    case "rounded-sine":
      v =
        100 +
        Math.sin(i / 50 + phase) * 40 +
        Math.sin(i / 200 + phase) * 20 +
        (Math.random() - 0.5) * 8;
      v = Math.round(v);
      break;
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
    case "live":
      // These are replaced by real values in startLiveBrowserScraper
      v = 0;
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
    description:
      "OpenTelemetry-style Kubernetes metrics across namespaces, nodes, pods, and containers.",
    metrics: [
      { name: "k8s.pod.cpu.usage", profile: "k8s-pod-cpu-usage", decimals: 3 },
      { name: "k8s.pod.memory.working_set", profile: "k8s-pod-memory-working-set", decimals: 0 },
      {
        name: "k8s.pod.network.io",
        profile: "k8s-pod-network-io",
        decimals: 0,
        labelDimensions: {
          "network.io.direction": ["receive", "transmit"],
          "network.interface.name": ["eth0"],
        },
      },
      { name: "k8s.container.restart.count", profile: "k8s-container-restart-count", decimals: 0 },
      {
        name: "k8s.container.cpu.limit_utilization",
        profile: "k8s-container-cpu-limit-utilization",
        decimals: 3,
      },
    ],
    buildLabelGroups: buildKubernetesLabelGroups,
    numPoints: 20000,
    intervalMs: 15000,
  },
  {
    id: "browser-live",
    name: "Live Browser Session",
    emoji: "🧭",
    isLive: true,
    description:
      "Real-time telemetry from your own browser session: mouse coordinates, interaction counts, memory heap, and scroll depth.",
    metrics: [
      { name: "browser_mouse_x", pattern: "live" },
      { name: "browser_mouse_y", pattern: "live" },
      { name: "browser_mouse_velocity", pattern: "live" },
      { name: "browser_interaction_clicks", pattern: "live" },
      { name: "browser_interaction_keypresses", pattern: "live" },
      { name: "browser_memory_used_bytes", pattern: "live" },
      { name: "browser_scroll_y", pattern: "live" },
      { name: "browser_window_width", pattern: "live" },
      { name: "browser_window_height", pattern: "live" },
      { name: "browser_connection_downlink", pattern: "live" },
      { name: "browser_event_loop_lag_ms", pattern: "live" },
    ],
    labelDimensions: {
      instance: ["current-session"],
    },
    numPoints: 1000,
    intervalMs: 200, // Slightly faster 5fps ingestion
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
  const baseGroups = scenario.buildLabelGroups
    ? scenario.buildLabelGroups()
    : _expandLabelDimensions(scenario.labelDimensions || {});
  return scenario.metrics.reduce((count, metric) => {
    const groups = expandMetricLabelGroups(baseGroups, metric.labelDimensions || {});
    return count + groups.length;
  }, 0);
}

/** Compute total sample count for a scenario. */
export function scenarioSampleCount(scenario) {
  return scenarioSeriesCount(scenario) * scenario.numPoints;
}

export function estimateScenarioArrayBytes(scenario) {
  return scenarioSampleCount(scenario) * APPROX_BYTES_PER_SAMPLE;
}

export function generateScenarioData(scenario, onProgress) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const intervalNs = BigInt(scenario.intervalMs) * 1_000_000n;
  const { numPoints, metrics } = scenario;
  const baseLabelGroups = scenario.buildLabelGroups
    ? scenario.buildLabelGroups()
    : _expandLabelDimensions(scenario.labelDimensions || {});
  const startT = now - BigInt(numPoints) * intervalNs;

  const totalSeries = metrics.reduce((count, metric) => {
    return count + expandMetricLabelGroups(baseLabelGroups, metric.labelDimensions || {}).length;
  }, 0);
  const series = [];
  let seriesIdx = 0;
  for (const m of metrics) {
    const labelGroups = expandMetricLabelGroups(baseLabelGroups, m.labelDimensions || {});
    for (const lg of labelGroups) {
      const labels = new Map([["__name__", m.name], ...Object.entries(lg)]);
      const timestamps = new BigInt64Array(numPoints);
      for (let i = 0; i < numPoints; i++) {
        timestamps[i] = startT + BigInt(i) * intervalNs;
      }
      const values = generateSeriesValues(m, labels, seriesIdx, numPoints, scenario.intervalMs);
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

export function startLiveBrowserScraper(store, scenario, onUpdate) {
  const intervalMs = scenario.intervalMs || 250;
  const metrics = scenario.metrics;
  const seriesIds = new Map();
  const labelGroup = { instance: "current-session" };

  for (const m of metrics) {
    const labels = new Map([["__name__", m.name], ...Object.entries(labelGroup)]);
    seriesIds.set(m.name, store.getOrCreateSeries(labels));
  }

  const state = {
    mouseX: 0,
    mouseY: 0,
    lastMouseX: 0,
    lastMouseY: 0,
    clicks: 0,
    keypresses: 0,
    scrollY: window.scrollY,
  };

  const onMouseMove = (e) => {
    state.mouseX = e.clientX;
    state.mouseY = e.clientY;
  };
  const onClick = () => state.clicks++;
  const onKeyDown = () => state.keypresses++;
  const onScroll = () => (state.scrollY = window.scrollY);

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onScroll);

  let lastTick = performance.now();
  let count = 0;

  const timer = setInterval(() => {
    const nowMs = performance.now();
    const lag = nowMs - lastTick - intervalMs;
    lastTick = nowMs;

    const now = BigInt(Date.now()) * 1_000_000n;
    const ts = new BigInt64Array([now]);

    const mem = performance?.memory || { usedJSHeapSize: 0 };
    const conn = navigator.connection || { downlink: 0 };

    const dx = state.mouseX - state.lastMouseX;
    const dy = state.mouseY - state.lastMouseY;
    const velocity = Math.sqrt(dx * dx + dy * dy);
    state.lastMouseX = state.mouseX;
    state.lastMouseY = state.mouseY;

    const values = {
      browser_mouse_x: state.mouseX,
      browser_mouse_y: state.mouseY,
      browser_mouse_velocity: velocity,
      browser_memory_used_bytes: mem.usedJSHeapSize,
      browser_scroll_y: state.scrollY,
      browser_interaction_clicks: state.clicks,
      browser_interaction_keypresses: state.keypresses,
      browser_window_width: window.innerWidth,
      browser_window_height: window.innerHeight,
      browser_connection_downlink: conn.downlink,
      browser_event_loop_lag_ms: Math.max(0, lag),
    };

    const appends = new Map();

    for (const [name, val] of Object.entries(values)) {
      const id = seriesIds.get(name);
      if (id !== undefined) {
        store.appendBatch(id, ts, new Float64Array([val]));
        appends.set(id, { timestamps: ts, values: new Float64Array([val]) });
      }
    }

    count++;

    if (onUpdate) onUpdate(count, appends);
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("beforeunload", stop);
  };

  window.addEventListener("beforeunload", stop);

  return stop;
}
