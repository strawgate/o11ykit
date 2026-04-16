import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


interface MetricRow {
  strategy: TransferStrategy;
  samples: number;
  roundTripMs: number;
  mainThreadBlockMs: number;
  memoryDeltaBytes: number;
}

const SIZES = [1_000, 10_000, 100_000, 1_000_000] as const;

type TransferStrategy = 'structured-clone' | 'transferable' | 'shared-array-buffer';

interface RequestEnvelope {
  id: number;
  kind: 'request';
  payload: {
    type: 'init';
    chunkSize?: number;
  } | {
    type: 'ingest';
    labels: Array<[string, string]>;
    timestamps: BigInt64Array;
    values: Float64Array;
  } | {
    type: 'query';
    opts: { metric: string; start: bigint; end: bigint };
  } | {
    type: 'close';
  } | {
    type: 'echo';
    payload: Uint8Array;
  };
  meta?: { strategy?: TransferStrategy; sentAt?: number };
}

interface ResponseEnvelope {
  id: number;
  kind: 'response';
  payload: { ok: false; type: 'error'; error: string }
    | { ok: true; type: 'init'; backend: string }
    | { ok: true; type: 'ingest'; seriesId: number; ingestedSamples: number }
    | { ok: true; type: 'query'; result: { series: unknown[] } }
    | { ok: true; type: 'stats'; stats: { seriesCount: number; sampleCount: number; memoryBytes: number } }
    | { ok: true; type: 'echo'; bytes: number }
    | { ok: true; type: 'close' };
}
const ITERATIONS = 12;

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '../../dist/worker.js');

type Pending = {
  resolve: (response: ResponseEnvelope) => void;
  reject: (error: unknown) => void;
};

class BenchWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(path: string) {
    this.worker = new Worker(path);
    this.worker.on('message', (raw: unknown) => {
      const message = raw as ResponseEnvelope;
      const handlers = this.pending.get(message.id);
      if (!handlers) return;
      this.pending.delete(message.id);
      handlers.resolve(message);
    });
    this.worker.on('error', (error) => {
      for (const [, handlers] of this.pending) {
        handlers.reject(error);
      }
      this.pending.clear();
    });
  }

  async request(
    payload: RequestEnvelope['payload'],
    strategy: TransferStrategy,
    transfer: ArrayBuffer[] = [],
  ): Promise<ResponseEnvelope> {
    const id = this.nextId++;
    const envelope: RequestEnvelope = {
      id,
      kind: 'request',
      payload,
      meta: { strategy, sentAt: performance.now() },
    };

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(envelope, transfer);
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

function supportsSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)] ?? 0;
}

function makePayload(strategy: TransferStrategy, samples: number): { payload: Uint8Array; transfer: ArrayBuffer[] } {
  const totalBytes = samples * 16; // mimic ts + value columns
  if (strategy === 'shared-array-buffer') {
    const sab = new SharedArrayBuffer(totalBytes);
    const view = new Uint8Array(sab);
    for (let i = 0; i < view.length; i++) view[i] = i & 0xff;
    return { payload: view, transfer: [] };
  }

  const payload = new Uint8Array(totalBytes);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  if (strategy === 'transferable') {
    return { payload, transfer: [payload.buffer] };
  }
  return { payload, transfer: [] };
}

async function measureMainThreadBlocking(
  run: () => Promise<void>,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let finished = false;

    setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(performance.now() - startedAt);
    }, 0);

    run().catch(reject);
  });
}

async function benchmarkStrategy(strategy: TransferStrategy, samples: number): Promise<MetricRow> {
  const client = new BenchWorkerClient(workerPath);

  const initResponse = await client.request({ type: 'init', chunkSize: 1024 }, strategy);
  if (!initResponse.payload.ok) {
    throw new Error(`init failed: ${initResponse.payload.error}`);
  }

  const rtts: number[] = [];
  const blocks: number[] = [];

  if (global.gc) global.gc();
  const before = process.memoryUsage();

  for (let i = 0; i < ITERATIONS; i++) {
    const { payload, transfer } = makePayload(strategy, samples);

    const blockMs = await measureMainThreadBlocking(async () => {
      const t0 = performance.now();
      const response = await client.request({ type: 'echo', payload }, strategy, transfer);
      const t1 = performance.now();
      if (!response.payload.ok) {
        throw new Error(`echo failed: ${response.payload.error}`);
      }
      rtts.push(t1 - t0);
    });

    blocks.push(blockMs);
  }

  if (global.gc) global.gc();
  const after = process.memoryUsage();
  const memoryDeltaBytes = (after.arrayBuffers + after.heapUsed) - (before.arrayBuffers + before.heapUsed);

  await client.request({ type: 'close' }, strategy);
  await client.terminate();

  return {
    strategy,
    samples,
    roundTripMs: p50(rtts),
    mainThreadBlockMs: p50(blocks),
    memoryDeltaBytes,
  };
}

async function runIngestQueryProof(): Promise<void> {
  const client = new BenchWorkerClient(workerPath);
  const init = await client.request({ type: 'init', chunkSize: 1024 }, 'structured-clone');
  if (!init.payload.ok) throw new Error(`init failed: ${init.payload.error}`);

  const n = 2_048;
  const timestamps = new BigInt64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = BigInt(1_700_000_000_000 + i * 1000);
    values[i] = Math.sin(i / 32);
  }

  const ingest = await client.request({
    type: 'ingest',
    labels: [['__name__', 'cpu_usage'], ['service', 'bench']],
    timestamps,
    values,
  }, 'structured-clone');
  if (!ingest.payload.ok) throw new Error(`ingest failed: ${ingest.payload.error}`);

  const query = await client.request({
    type: 'query',
    opts: {
      metric: 'cpu_usage',
      start: timestamps[0]!,
      end: timestamps[n - 1]!,
    },
  }, 'structured-clone');

  if (!query.payload.ok) throw new Error(`query failed: ${query.payload.error}`);
  if (query.payload.type !== 'query') throw new Error(`unexpected response: ${query.payload.type}`);
  if (query.payload.result.series.length !== 1) {
    throw new Error(`expected 1 series, got ${query.payload.result.series.length}`);
  }

  await client.request({ type: 'close' }, 'structured-clone');
  await client.terminate();
}

function printRows(rows: MetricRow[]): void {
  const header = [
    'strategy'.padEnd(20),
    'samples'.padStart(10),
    'p50 RTT (ms)'.padStart(14),
    'p50 block (ms)'.padStart(16),
    'mem delta (KB)'.padStart(15),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log([
      row.strategy.padEnd(20),
      String(row.samples).padStart(10),
      row.roundTripMs.toFixed(3).padStart(14),
      row.mainThreadBlockMs.toFixed(3).padStart(16),
      (row.memoryDeltaBytes / 1024).toFixed(1).padStart(15),
    ].join(' | '));
  }
}

async function main(): Promise<void> {
  await runIngestQueryProof();

  const strategies: TransferStrategy[] = ['structured-clone', 'transferable'];
  if (supportsSharedArrayBuffer()) strategies.push('shared-array-buffer');

  const rows: MetricRow[] = [];
  for (const strategy of strategies) {
    for (const samples of SIZES) {
      rows.push(await benchmarkStrategy(strategy, samples));
    }
  }

  printRows(rows);

  const summary = {
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    rows,
    sharedArrayBufferAvailable: supportsSharedArrayBuffer(),
  };
  console.log('\nJSON summary:');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
