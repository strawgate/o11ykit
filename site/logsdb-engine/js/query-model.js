// @ts-nocheck
// ── Query Model ───────────────────────────────────────────────────────
// Bridges the UI query builder to the o11ylogsdb query engine.
// Translates form state into QuerySpec and formats results.

import { query } from "o11ylogsdb";

// ── Query Builder State ──────────────────────────────────────────────

/**
 * Create a fresh query builder state.
 */
export function createQueryState() {
  return {
    timeRange: { enabled: false, from: null, to: null },
    severity: { enabled: false, min: "WARN" },
    bodyContains: { enabled: false, value: "" },
    bodyLeafEquals: { enabled: false, path: "", value: "" },
    resourceEquals: { enabled: false, key: "service.name", value: "" },
    limit: { enabled: true, value: 100 },
  };
}

const SEVERITY_MAP = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

/**
 * Build a QuerySpec from the UI state.
 */
export function buildQuerySpec(state) {
  const spec = {};

  if (state.timeRange.enabled && state.timeRange.from && state.timeRange.to) {
    spec.range = {
      from: BigInt(state.timeRange.from) * 1_000_000n,
      to: BigInt(state.timeRange.to) * 1_000_000n,
    };
  }

  if (state.severity.enabled && state.severity.min) {
    spec.severityGte = SEVERITY_MAP[state.severity.min] ?? 9;
  }

  if (state.bodyContains.enabled && state.bodyContains.value) {
    spec.bodyContains = state.bodyContains.value;
  }

  if (state.bodyLeafEquals.enabled && state.bodyLeafEquals.path && state.bodyLeafEquals.value) {
    spec.bodyLeafEquals = {};
    // Try to parse as number or boolean
    let val = state.bodyLeafEquals.value;
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (!isNaN(Number(val)) && val !== "") val = Number(val);
    spec.bodyLeafEquals[state.bodyLeafEquals.path] = val;
  }

  if (state.resourceEquals.enabled && state.resourceEquals.key && state.resourceEquals.value) {
    spec.resourceEquals = {};
    spec.resourceEquals[state.resourceEquals.key] = state.resourceEquals.value;
  }

  if (state.limit.enabled && state.limit.value > 0) {
    spec.limit = state.limit.value;
  }

  return spec;
}

/**
 * Execute a query against the store and return formatted results.
 */
export function executeQuery(store, state) {
  const spec = buildQuerySpec(state);
  const t0 = performance.now();
  const result = query(store, spec);
  const elapsed = performance.now() - t0;

  return {
    records: result.records,
    stats: {
      ...result.stats,
      totalTimeMs: elapsed.toFixed(1),
      recordsPerMs: result.stats.recordsEmitted > 0
        ? (result.stats.recordsEmitted / elapsed).toFixed(1)
        : "0",
    },
    spec,
  };
}

// ── Result Formatting ────────────────────────────────────────────────

const SEVERITY_LABELS = {
  1: "TRACE",
  2: "TRACE2",
  3: "TRACE3",
  4: "TRACE4",
  5: "DEBUG",
  6: "DEBUG2",
  7: "DEBUG3",
  8: "DEBUG4",
  9: "INFO",
  10: "INFO2",
  11: "INFO3",
  12: "INFO4",
  13: "WARN",
  14: "WARN2",
  15: "WARN3",
  16: "WARN4",
  17: "ERROR",
  18: "ERROR2",
  19: "ERROR3",
  20: "ERROR4",
  21: "FATAL",
  22: "FATAL2",
  23: "FATAL3",
  24: "FATAL4",
};

const SEVERITY_COLORS = {
  TRACE: "#6b7280",
  DEBUG: "#3b82f6",
  INFO: "#10b981",
  WARN: "#f59e0b",
  ERROR: "#ef4444",
  FATAL: "#dc2626",
};

export function severityLabel(num) {
  return SEVERITY_LABELS[num] ?? `SEV${num}`;
}

export function severityColor(num) {
  if (num <= 4) return SEVERITY_COLORS.TRACE;
  if (num <= 8) return SEVERITY_COLORS.DEBUG;
  if (num <= 12) return SEVERITY_COLORS.INFO;
  if (num <= 16) return SEVERITY_COLORS.WARN;
  if (num <= 20) return SEVERITY_COLORS.ERROR;
  return SEVERITY_COLORS.FATAL;
}

export function formatTimestamp(nanos) {
  const ms = Number(nanos / 1_000_000n);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function formatBody(body) {
  if (typeof body === "string") return body;
  if (body === null || body === undefined) return "";
  if (body instanceof Uint8Array) return `<binary ${body.length} bytes>`;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function formatBodyPreview(body, maxLen = 120) {
  const full = typeof body === "string" ? body : JSON.stringify(body);
  if (full.length <= maxLen) return full;
  return full.slice(0, maxLen) + "…";
}

/**
 * Compute severity distribution from query results.
 */
export function computeSeverityDistribution(records) {
  const dist = { TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 };
  for (const r of records) {
    const label = severityLabel(r.severityNumber);
    const bucket = label.startsWith("TRACE")
      ? "TRACE"
      : label.startsWith("DEBUG")
        ? "DEBUG"
        : label.startsWith("INFO")
          ? "INFO"
          : label.startsWith("WARN")
            ? "WARN"
            : label.startsWith("ERROR")
              ? "ERROR"
              : "FATAL";
    dist[bucket]++;
  }
  return dist;
}

/**
 * Compute per-service record count from results.
 */
export function computeServiceDistribution(records) {
  const dist = {};
  for (const r of records) {
    const svc = r.attributes?.find((a) => a.key === "service.name")?.value ?? "unknown";
    dist[svc] = (dist[svc] || 0) + 1;
  }
  return dist;
}
