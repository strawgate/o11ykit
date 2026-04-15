import { describe, expect, it } from 'vitest';

import { FlatStore } from '../src/flat-store.js';
import { ChunkedStore } from '../src/chunked-store.js';
import { ColumnStore } from '../src/column-store.js';
import { encodeChunk, decodeChunk } from '../src/codec.js';
import type { Codec, StorageBackend, Labels, ValuesCodec } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

const tsCodec: Codec = {
  name: 'ts-xor-delta',
  encode: encodeChunk,
  decode: decodeChunk,
};

const tsValuesCodec: ValuesCodec = {
  name: 'identity',
  encodeValues(values: Float64Array): Uint8Array {
    return new Uint8Array(values.buffer.slice(0));
  },
  decodeValues(buf: Uint8Array): Float64Array {
    return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  },
};

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const m = new Map<string, string>();
  m.set('__name__', name);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
  }
  return m;
}

function insertSamples(store: StorageBackend, labels: Labels, count: number, t0 = 1_000_000n, interval = 15_000n) {
  const id = store.getOrCreateSeries(labels);
  for (let i = 0; i < count; i++) {
    store.append(id, t0 + BigInt(i) * interval, i * 1.5);
  }
  return id;
}

function insertBatch(store: StorageBackend, labels: Labels, count: number, t0 = 1_000_000n, interval = 15_000n) {
  const id = store.getOrCreateSeries(labels);
  const ts = new BigInt64Array(count);
  const vals = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    ts[i] = t0 + BigInt(i) * interval;
    vals[i] = i * 1.5;
  }
  store.appendBatch(id, ts, vals);
  return id;
}

// ── Generic storage backend contract tests ───────────────────────────

function describeStorageBackend(name: string, create: () => StorageBackend) {
  describe(name, () => {
    it('creates and retrieves series by labels', () => {
      const store = create();
      const labels = makeLabels('cpu', { host: 'a' });
      const id1 = store.getOrCreateSeries(labels);
      const id2 = store.getOrCreateSeries(labels);
      expect(id1).toBe(id2); // same labels → same id

      const id3 = store.getOrCreateSeries(makeLabels('cpu', { host: 'b' }));
      expect(id3).not.toBe(id1); // different labels → different id
    });

    it('appends and reads samples', () => {
      const store = create();
      const id = insertSamples(store, makeLabels('metric_a'), 10);
      expect(store.sampleCount).toBe(10);

      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(10);
      expect(data.values[0]).toBe(0);
      expect(data.values[9]).toBe(9 * 1.5);
    });

    it('reads with time range filter', () => {
      const store = create();
      const t0 = 1_000_000n;
      const interval = 15_000n;
      const id = insertSamples(store, makeLabels('metric_b'), 100, t0, interval);

      // Read middle third
      const start = t0 + 33n * interval;
      const end = t0 + 66n * interval;
      const data = store.read(id, start, end);
      expect(data.timestamps.length).toBeGreaterThanOrEqual(30);
      expect(data.timestamps.length).toBeLessThanOrEqual(40);
      for (const ts of data.timestamps) {
        expect(ts).toBeGreaterThanOrEqual(start);
        expect(ts).toBeLessThanOrEqual(end);
      }
    });

    it('appendBatch inserts all samples', () => {
      const store = create();
      const id = insertBatch(store, makeLabels('batch_metric'), 200);
      expect(store.sampleCount).toBe(200);
      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(200);
    });

    it('matchLabel finds correct series', () => {
      const store = create();
      insertSamples(store, makeLabels('cpu', { host: 'a' }), 5);
      insertSamples(store, makeLabels('cpu', { host: 'b' }), 5);
      insertSamples(store, makeLabels('mem', { host: 'a' }), 5);

      const cpuIds = store.matchLabel('__name__', 'cpu');
      expect(cpuIds.length).toBe(2);

      const hostAIds = store.matchLabel('host', 'a');
      expect(hostAIds.length).toBe(2);

      const memIds = store.matchLabel('__name__', 'mem');
      expect(memIds.length).toBe(1);
    });

    it('labels() returns correct label map', () => {
      const store = create();
      const labels = makeLabels('test_metric', { env: 'prod', region: 'us-east' });
      const id = store.getOrCreateSeries(labels);
      const retrieved = store.labels(id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.get('__name__')).toBe('test_metric');
      expect(retrieved!.get('env')).toBe('prod');
      expect(retrieved!.get('region')).toBe('us-east');
    });

    it('labels() returns undefined for invalid id', () => {
      const store = create();
      expect(store.labels(999)).toBeUndefined();
    });

    it('seriesCount and sampleCount track correctly', () => {
      const store = create();
      expect(store.seriesCount).toBe(0);
      expect(store.sampleCount).toBe(0);

      insertSamples(store, makeLabels('m1'), 10);
      expect(store.seriesCount).toBe(1);
      expect(store.sampleCount).toBe(10);

      insertSamples(store, makeLabels('m2'), 20);
      expect(store.seriesCount).toBe(2);
      expect(store.sampleCount).toBe(30);
    });

    it('memoryBytes returns positive value', () => {
      const store = create();
      insertSamples(store, makeLabels('m1'), 100);
      expect(store.memoryBytes()).toBeGreaterThan(0);
    });

    it('handles large batch spanning multiple chunks', () => {
      const store = create();
      const id = insertBatch(store, makeLabels('big_metric'), 5000);
      expect(store.sampleCount).toBe(5000);
      const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
      expect(data.timestamps.length).toBe(5000);
      // Verify first and last values are correct
      expect(data.values[0]).toBe(0);
      expect(data.values[4999]).toBeCloseTo(4999 * 1.5);
    });
  });
}

// ── Run contract tests against each backend ──────────────────────────

describeStorageBackend('FlatStore', () => new FlatStore());
describeStorageBackend('ChunkedStore (chunk=64)', () => new ChunkedStore(tsCodec, 64));
describeStorageBackend('ChunkedStore (chunk=640)', () => new ChunkedStore(tsCodec, 640));
describeStorageBackend('ColumnStore (chunk=64)', () => new ColumnStore(tsValuesCodec, 64));

// ── ChunkedStore-specific tests ──────────────────────────────────────

describe('ChunkedStore freeze behavior', () => {
  it('freezes chunks when reaching chunk size', () => {
    const store = new ChunkedStore(tsCodec, 16);
    const id = insertSamples(store, makeLabels('freeze_test'), 48);

    // 48 samples with chunk size 16 → 3 frozen chunks, hot chunk empty
    const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(48);

    // Compressed should use less memory than flat
    const flat = new FlatStore();
    const flatId = insertSamples(flat, makeLabels('freeze_test'), 48);
    expect(store.memoryBytes()).toBeLessThan(flat.memoryBytes());
  });

  it('correctly reads across frozen and hot chunks', () => {
    const store = new ChunkedStore(tsCodec, 10);
    const id = insertSamples(store, makeLabels('mixed'), 25);

    // 25 samples with chunk size 10 → 2 frozen chunks + 5 in hot
    const data = store.read(id, 0n, BigInt(Number.MAX_SAFE_INTEGER));
    expect(data.timestamps.length).toBe(25);

    // Verify continuity
    for (let i = 0; i < 25; i++) {
      expect(data.values[i]).toBeCloseTo(i * 1.5);
    }
  });
});
