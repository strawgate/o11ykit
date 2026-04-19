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

export function generateValue(pattern, i, seriesIdx, total) {
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
