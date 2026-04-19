import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ColumnStore } from '../../packages/o11ytsdb/dist/column-store.js';
import { ingestOtlpJson } from '../../packages/o11ytsdb/dist/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '../../packages/o11ytsdb/dist/worker.js');

const BATCH_POINTS = 10_000;
const ITERATIONS = 15;

function createValuesCodec() {
  return {
    name: 'f64-plain',
    encodeValues(values) {
      const out = new Uint8Array(4 + values.byteLength);
      new DataView(out.buffer).setUint32(0, values.length, true);
      out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
      return out;
    },
    decodeValues(buf) {
      if (buf.byteLength < 4) return new Float64Array(0);
      const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
      const raw = buf.subarray(4);
      const bytes = raw.byteLength - (raw.byteLength % 8);
      const copy = raw.slice(0, bytes);
      const values = new Float64Array(copy.buffer, copy.byteOffset, Math.min(n, Math.floor(bytes / 8)));
      return values.slice();
    },
  };
}

function makePayload(points) {
  const dataPoints = new Array(points);
  const baseNs = 1_700_000_000_000_000_000n;
  for (let i = 0; i < points; i++) {
    dataPoints[i] = {
      timeUnixNano: (baseNs + BigInt(i) * 1_000_000n).toString(),
      asDouble: Number((Math.sin(i / 250) * 100 + 500).toFixed(6)),
      attributes: [{ key: 'host', value: { stringValue: `web-${i % 8}` } }],
    };
  }

  return JSON.stringify({
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker-bench' } }] },
      scopeMetrics: [{
        scope: { name: 'bench.ingest', version: '0.1.0' },
        metrics: [{
          name: 'http_server_duration_ms',
          gauge: { dataPoints },
        }],
      }],
    }],
  });
}

function p50(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureImmediateDelay(startedAt) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(performance.now() - startedAt);
    }, 0);
  });
}

class BenchWorkerClient {
  constructor(path) {
    this.worker = new Worker(path);
    this.nextId = 1;
    this.pending = new Map();

    this.worker.on('message', (message) => {
      const handlers = this.pending.get(message.id);
      if (!handlers) return;
      this.pending.delete(message.id);
      handlers.resolve(message.payload);
    });

    this.worker.on('error', (error) => {
      for (const [, handlers] of this.pending) handlers.reject(error);
      this.pending.clear();
    });
  }

  request(payload, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        kind: 'request',
        payload,
        meta: { strategy: transfer.length > 0 ? 'transferable' : 'structured-clone', sentAt: Date.now() },
      }, transfer);
    });
  }

  async init() {
    const response = await this.request({ type: 'init', chunkSize: 1024 });
    if (!response.ok) throw new Error(response.error);
  }

  async ingest(payloadJson) {
    const encoded = new TextEncoder().encode(payloadJson);
    const response = await this.request({ type: 'ingest', payload: encoded }, [encoded.buffer]);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  async close() {
    await this.request({ type: 'close' });
    await this.worker.terminate();
  }
}

async function run() {
  const payload = makePayload(BATCH_POINTS);

  const syncStore = new ColumnStore(createValuesCodec(), 1024);
  const syncDurations = [];
  const syncBlocks = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const delayPromise = measureImmediateDelay(start);
    ingestOtlpJson(payload, syncStore);
    const end = performance.now();
    syncDurations.push(end - start);
    syncBlocks.push(await delayPromise);
  }

  const workerClient = new BenchWorkerClient(workerPath);
  await workerClient.init();

  const workerRoundTrips = [];
  const workerBlocks = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const delayPromise = measureImmediateDelay(start);
    await workerClient.ingest(payload);
    const end = performance.now();
    workerRoundTrips.push(end - start);
    workerBlocks.push(await delayPromise);
  }

  await workerClient.close();

  const report = {
    batchPoints: BATCH_POINTS,
    iterations: ITERATIONS,
    sync: {
      p50MainThreadBlockMs: p50(syncBlocks),
      p50IngestWallMs: p50(syncDurations),
      throughputPointsPerSec: Math.round(BATCH_POINTS / (p50(syncDurations) / 1000)),
    },
    worker: {
      p50MainThreadBlockMs: p50(workerBlocks),
      p50RoundTripMs: p50(workerRoundTrips),
      throughputPointsPerSec: Math.round(BATCH_POINTS / (p50(workerRoundTrips) / 1000)),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
