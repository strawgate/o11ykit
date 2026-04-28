// @ts-nocheck
// ── Logs Explorer Model ───────────────────────────────────────────────
// Curated log exploration view. Surfaces problematic patterns,
// error clusters, template analysis, and time-based insights.

import { query } from "o11ylogsdb";

/**
 * Analyze the store and produce curated insights.
 */
export function analyzeStore(store) {
  store.flush();
  const stats = store.stats();

  // Query for errors
  const errors = query(store, { severityGte: 17, limit: 500 });
  // Query for warnings
  const warnings = query(store, { severityGte: 13, limit: 500 });
  // Recent logs sample
  const recent = query(store, { limit: 200 });

  const errorRecords = errors.records;
  const warningRecords = warnings.records.filter((r) => r.severityNumber < 17);

  return {
    overview: {
      totalLogs: stats.totalLogs,
      streams: stats.streams,
      chunks: stats.chunks,
      bytesPerLog: stats.bytesPerLog,
      totalBytes: stats.totalChunkBytes,
    },
    errors: analyzeErrors(errorRecords),
    warnings: analyzeWarnings(warningRecords),
    templates: analyzeTemplates(recent.records),
    timeline: buildTimeline(recent.records),
    services: analyzeServices(store),
  };
}

function analyzeErrors(records) {
  const clusters = {};
  for (const r of records) {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    // Simple error clustering by first 60 chars
    const key = body.slice(0, 60);
    if (!clusters[key]) {
      clusters[key] = { sample: r, count: 0, services: new Set() };
    }
    clusters[key].count++;
    const svc = r.attributes?.find((a) => a.key === "service.name")?.value;
    if (svc) clusters[key].services.add(svc);
  }

  return Object.values(clusters)
    .map((c) => ({
      body: typeof c.sample.body === "string" ? c.sample.body : JSON.stringify(c.sample.body),
      count: c.count,
      services: [...c.services],
      severity: c.sample.severityNumber,
      firstSeen: c.sample.timeUnixNano,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function analyzeWarnings(records) {
  const clusters = {};
  for (const r of records) {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const key = body.slice(0, 60);
    if (!clusters[key]) {
      clusters[key] = { sample: r, count: 0 };
    }
    clusters[key].count++;
  }

  return Object.values(clusters)
    .map((c) => ({
      body: typeof c.sample.body === "string" ? c.sample.body : JSON.stringify(c.sample.body),
      count: c.count,
      severity: c.sample.severityNumber,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function analyzeTemplates(records) {
  const templates = {};
  for (const r of records) {
    if (typeof r.body !== "string") continue;
    // Extract template pattern by replacing numbers, UUIDs, IPs
    const pattern = r.body
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "{uuid}")
      .replace(/\b\d+\.\d+\.\d+\.\d+\b/g, "{ip}")
      .replace(/\b\d{4,}\b/g, "{num}")
      .replace(/\b[0-9a-f]{8}\b/g, "{id}");

    if (!templates[pattern]) {
      templates[pattern] = { pattern, count: 0, sample: r.body };
    }
    templates[pattern].count++;
  }

  return Object.values(templates)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

function buildTimeline(records) {
  if (records.length === 0) return [];

  // Group by minute
  const buckets = {};
  for (const r of records) {
    const ms = Number(r.timeUnixNano / 1_000_000n);
    const minute = Math.floor(ms / 60000) * 60000;
    if (!buckets[minute]) {
      buckets[minute] = { timestamp: minute, total: 0, errors: 0, warnings: 0 };
    }
    buckets[minute].total++;
    if (r.severityNumber >= 17) buckets[minute].errors++;
    else if (r.severityNumber >= 13) buckets[minute].warnings++;
  }

  return Object.values(buckets).sort((a, b) => a.timestamp - b.timestamp);
}

function analyzeServices(store) {
  const services = {};
  for (const streamId of store.streams.ids()) {
    const resource = store.streams.resourceOf(streamId);
    const svc = resource.attributes.find((a) => a.key === "service.name")?.value ?? "unknown";
    const chunks = store.streams.chunksOf(streamId);

    if (!services[svc]) {
      services[svc] = { name: svc, logs: 0, bytes: 0, chunks: 0, errorRate: 0, errors: 0 };
    }

    for (const chunk of chunks) {
      services[svc].logs += chunk.header.nLogs;
      services[svc].bytes += (chunk.payload?.byteLength ?? 0) + 150;
      services[svc].chunks++;
    }
  }

  // Query errors per service
  for (const svc of Object.keys(services)) {
    const errorResult = query(store, {
      resourceEquals: { "service.name": svc },
      severityGte: 17,
      limit: 10000,
    });
    services[svc].errors = errorResult.stats.recordsEmitted;
    services[svc].errorRate =
      services[svc].logs > 0 ? ((services[svc].errors / services[svc].logs) * 100).toFixed(2) : "0";
  }

  return Object.values(services).sort((a, b) => b.logs - a.logs);
}

/**
 * Get a live tail of the most recent logs.
 */
export function getRecentLogs(store, limit = 50) {
  store.flush();
  const result = query(store, { limit });
  return result.records;
}
