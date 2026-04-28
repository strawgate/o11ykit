// @ts-nocheck
// ── Storage Model ─────────────────────────────────────────────────────
// Wraps the real o11ylogsdb engine for the interactive demo.
// Handles ingest, stats computation, and chunk-level inspection.

import { LogStore, query, TypedColumnarDrainPolicy } from "o11ylogsdb";

// ── Engine Setup ─────────────────────────────────────────────────────

const DEFAULT_RESOURCE = {
  attributes: [
    { key: "service.version", value: "1.0.0" },
    { key: "telemetry.sdk.name", value: "o11ykit" },
  ],
};

const DEFAULT_SCOPE = {
  name: "o11ylogsdb-demo",
  version: "1.0.0",
  attributes: [],
};

/**
 * Create a LogStore configured with the TypedColumnarDrainPolicy —
 * the most advanced codec that achieves ~3-17 B/log.
 */
export function createStore(opts = {}) {
  const { rowsPerChunk = 1024 } = opts;

  const store = new LogStore({
    rowsPerChunk,
    policyFactory: () =>
      new TypedColumnarDrainPolicy({
        bodyCodec: "raw",
      }),
  });

  return store;
}

/**
 * Ingest an array of log records into the store.
 * Groups records by service.name attribute to simulate per-stream routing.
 */
export function ingestRecords(store, records) {
  const t0 = performance.now();
  let appended = 0;
  let chunksClosed = 0;

  for (const record of records) {
    const serviceName =
      record.attributes?.find((a) => a.key === "service.name")?.value ?? "unknown";

    const resource = {
      attributes: [{ key: "service.name", value: serviceName }, ...DEFAULT_RESOURCE.attributes],
    };

    const result = store.append(resource, DEFAULT_SCOPE, record);
    appended += result.recordsAppended;
    chunksClosed = result.chunksClosed;
  }

  const elapsed = performance.now() - t0;

  return {
    recordsIngested: appended,
    chunksClosed,
    ingestTimeMs: elapsed,
    logsPerSecond: Math.round((appended / elapsed) * 1000),
  };
}

/**
 * Get comprehensive stats about the store's current state.
 */
export function getStoreStats(store) {
  store.flush();
  const stats = store.stats();

  return {
    ...stats,
    compressionRatio:
      stats.totalLogs > 0 ? estimateRawSize(stats.totalLogs) / stats.totalChunkBytes : 0,
    bytesPerLogFormatted: stats.bytesPerLog.toFixed(2),
    totalMB: (stats.totalChunkBytes / (1024 * 1024)).toFixed(2),
    rawMB: (estimateRawSize(stats.totalLogs) / (1024 * 1024)).toFixed(2),
  };
}

function estimateRawSize(logCount) {
  // Average raw OTLP/JSON log record is ~350 bytes
  return logCount * 350;
}

/**
 * Get chunk-level breakdown for the storage explorer.
 */
export function getChunkDetails(store) {
  store.flush();
  const chunks = [];

  for (const streamId of store.streams.ids()) {
    const resource = store.streams.resourceOf(streamId);
    const serviceName =
      resource.attributes.find((a) => a.key === "service.name")?.value ?? "unknown";
    const streamChunks = store.streams.chunksOf(streamId);

    for (let i = 0; i < streamChunks.length; i++) {
      const chunk = streamChunks[i];
      const header = chunk.header;
      const payloadBytes = chunk.payload?.byteLength ?? 0;
      const headerBytes = estimateHeaderSize(header);
      const totalBytes = payloadBytes + headerBytes;

      chunks.push({
        streamId,
        service: serviceName,
        chunkIndex: i,
        nLogs: header.nLogs,
        totalBytes,
        payloadBytes,
        headerBytes,
        bytesPerLog: header.nLogs > 0 ? (totalBytes / header.nLogs).toFixed(2) : "0",
        timeRange: {
          min: header.timeRange.minNano,
          max: header.timeRange.maxNano,
        },
        severityRange: header.severityRange ?? null,
        compressionRatio:
          header.nLogs > 0 ? (estimateRawSize(header.nLogs) / totalBytes).toFixed(1) : "0",
      });
    }
  }

  return chunks.sort((a, b) => Number(a.timeRange.min - b.timeRange.min));
}

function estimateHeaderSize(_header) {
  // Rough estimate: JSON-serialized header is ~100-200 bytes
  return 150;
}

/**
 * Get per-service storage breakdown.
 */
export function getServiceBreakdown(store) {
  store.flush();
  const services = {};

  for (const streamId of store.streams.ids()) {
    const resource = store.streams.resourceOf(streamId);
    const serviceName =
      resource.attributes.find((a) => a.key === "service.name")?.value ?? "unknown";
    const streamChunks = store.streams.chunksOf(streamId);

    if (!services[serviceName]) {
      services[serviceName] = { logs: 0, bytes: 0, chunks: 0 };
    }

    for (const chunk of streamChunks) {
      services[serviceName].logs += chunk.header.nLogs;
      services[serviceName].bytes += (chunk.payload?.byteLength ?? 0) + 150;
      services[serviceName].chunks++;
    }
  }

  return Object.entries(services)
    .map(([name, data]) => ({
      name,
      ...data,
      bytesPerLog: data.logs > 0 ? (data.bytes / data.logs).toFixed(2) : "0",
      compressionRatio: data.logs > 0 ? (estimateRawSize(data.logs) / data.bytes).toFixed(1) : "0",
    }))
    .sort((a, b) => b.logs - a.logs);
}

/**
 * Run a query against the store and return results + stats.
 */
export function runQuery(store, spec) {
  store.flush();
  return query(store, spec);
}
