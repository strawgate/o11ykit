import { describe, expect, it } from 'vitest';

import { FlatStore } from '../src/flat-store.js';
import { ScanEngine } from '../src/query.js';
import type { Labels, StorageBackend } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeLabels(name: string, extra?: Record<string, string>): Labels {
  const m = new Map<string, string>();
  m.set('__name__', name);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
  }
  return m;
}

function populateStore(): FlatStore {
  const store = new FlatStore();
  // 3 CPU series for hosts a, b, c — each with 100 points
  for (const host of ['a', 'b', 'c']) {
    const id = store.getOrCreateSeries(makeLabels('cpu', { host, region: 'us-east' }));
    for (let i = 0; i < 100; i++) {
      store.append(id, 1_000_000n + BigInt(i) * 15_000n, 10 + (host.charCodeAt(0) - 97) * 10 + i * 0.1);
    }
  }
  // 1 memory series
  const memId = store.getOrCreateSeries(makeLabels('mem', { host: 'a' }));
  for (let i = 0; i < 50; i++) {
    store.append(memId, 1_000_000n + BigInt(i) * 15_000n, 8192 + i);
  }
  return store;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ScanEngine', () => {
  const engine = new ScanEngine();

  it('queries single metric without aggregation', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(3);
    expect(result.scannedSeries).toBe(3);
    expect(result.scannedSamples).toBe(300);
  });

  it('filters by label matcher', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      matchers: [{ label: 'host', value: 'b' }],
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(1);
    expect(result.series[0]!.labels.get('host')).toBe('b');
  });

  it('filters by time range', () => {
    const store = populateStore();
    const start = 1_000_000n + 50n * 15_000n;
    const end = 1_000_000n + 70n * 15_000n;
    const result = engine.query(store, {
      metric: 'cpu',
      matchers: [{ label: 'host', value: 'a' }],
      start,
      end,
    });
    expect(result.series.length).toBe(1);
    const s = result.series[0]!;
    expect(s.timestamps.length).toBeGreaterThanOrEqual(15);
    expect(s.timestamps.length).toBeLessThanOrEqual(25);
  });

  it('returns empty for non-existent metric', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'nonexistent',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(0);
    expect(result.scannedSeries).toBe(0);
  });

  it('aggregates with sum', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'sum',
    });
    expect(result.series.length).toBe(1);
    // Sum of 3 series at each point
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(100);
    // First point: 10 + 20 + 30 = 60
    expect(s.values[0]).toBeCloseTo(60);
  });

  it('aggregates with avg', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'avg',
    });
    expect(result.series.length).toBe(1);
    // Avg of 10, 20, 30 = 20
    expect(result.series[0]!.values[0]).toBeCloseTo(20);
  });

  it('aggregates with min', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'min',
    });
    expect(result.series[0]!.values[0]).toBeCloseTo(10);
  });

  it('aggregates with max', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'max',
    });
    expect(result.series[0]!.values[0]).toBeCloseTo(30);
  });

  it('aggregates with count', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'count',
    });
    // 3 series contribute to each point
    expect(result.series[0]!.values[0]).toBe(3);
  });

  it('aggregates with rate', () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels('counter'));
    // Counter: 0, 100, 200, 300 at 1-second intervals (1e9 ns)
    for (let i = 0; i < 4; i++) {
      store.append(id, BigInt(i) * 1_000_000_000n, i * 100);
    }
    const result = engine.query(store, {
      metric: 'counter',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'rate',
    });
    // rate = delta_v / delta_t (in seconds, but delta is in ms)
    const s = result.series[0]!;
    expect(s.timestamps.length).toBe(4);
    // First rate is 0 (no previous)
    expect(s.values[0]).toBe(0);
    // Subsequent: 100 / (1e9/1000) = 100 / 1e6 = 0.0001
    expect(s.values[1]).toBeCloseTo(0.0001);
  });

  it('step aggregation buckets correctly', () => {
    const store = new FlatStore();
    const id = store.getOrCreateSeries(makeLabels('stepped'));
    // 10 points at 1s intervals
    for (let i = 0; i < 10; i++) {
      store.append(id, BigInt(i) * 1_000n, i + 1);
    }
    const result = engine.query(store, {
      metric: 'stepped',
      start: 0n,
      end: 10_000n,
      agg: 'sum',
      step: 3_000n,
    });
    // Buckets: [0,3000), [3000,6000), [6000,9000), [9000,...]
    expect(result.series[0]!.timestamps.length).toBe(4);
  });

  it('groupBy creates separate aggregations', () => {
    const store = populateStore();
    const result = engine.query(store, {
      metric: 'cpu',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'sum',
      groupBy: ['host'],
    });
    // 3 distinct hosts → 3 groups
    expect(result.series.length).toBe(3);
    for (const s of result.series) {
      expect(s.labels.get('host')).toBeDefined();
      expect(s.timestamps.length).toBe(100);
    }
  });

  it('handles empty store gracefully', () => {
    const store = new FlatStore();
    const result = engine.query(store, {
      metric: 'anything',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
    });
    expect(result.series.length).toBe(0);
  });

  it('handles aggregation on empty result', () => {
    const store = new FlatStore();
    const result = engine.query(store, {
      metric: 'nothing',
      start: 0n,
      end: BigInt(Number.MAX_SAFE_INTEGER),
      agg: 'sum',
    });
    expect(result.series.length).toBe(0);
    expect(result.scannedSamples).toBe(0);
  });
});
