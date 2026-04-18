import { describe, it, expect } from 'vitest'
import { FlatStore, ChunkedStore } from '../js/stores.js'

// ── Helpers ──────────────────────────────────────────────────────────

function pushSample(store, labels, ts, val) {
  const id = store.getOrCreateSeries(labels)
  store.appendBatch(id, new BigInt64Array([ts]), new Float64Array([val]))
  return id
}

function pushSamples(store, labels, timestamps, values) {
  const id = store.getOrCreateSeries(labels)
  store.appendBatch(id, new BigInt64Array(timestamps), new Float64Array(values))
  return id
}

const CPU_LABELS = new Map([['__name__', 'cpu'], ['host', 'a']])
const MEM_LABELS = new Map([['__name__', 'mem'], ['host', 'a']])
const CPU_LABELS_B = new Map([['__name__', 'cpu'], ['host', 'b']])

// ── FlatStore ────────────────────────────────────────────────────────

describe('FlatStore', () => {
  it('creates store with correct name', () => {
    const store = new FlatStore()
    expect(store.name).toBe('FlatStore')
  })

  it('pushes and reads back data', () => {
    const store = new FlatStore()
    pushSample(store, CPU_LABELS, 1000n, 42.5)
    pushSample(store, CPU_LABELS, 2000n, 43.0)

    const ids = store.matchLabel('__name__', 'cpu')
    expect(ids.length).toBe(1)
    const data = store.read(ids[0], 0n, 10000n)
    expect(data.timestamps.length).toBe(2)
    expect(data.timestamps[0]).toBe(1000n)
    expect(data.timestamps[1]).toBe(2000n)
    expect(data.values[0]).toBeCloseTo(42.5)
    expect(data.values[1]).toBeCloseTo(43.0)
  })

  it('matches labels correctly', () => {
    const store = new FlatStore()
    pushSample(store, CPU_LABELS, 1000n, 1.0)
    pushSample(store, MEM_LABELS, 1000n, 2.0)
    pushSample(store, CPU_LABELS_B, 1000n, 3.0)

    const cpuIds = store.matchLabel('__name__', 'cpu')
    expect(cpuIds.length).toBe(2)
    const memIds = store.matchLabel('__name__', 'mem')
    expect(memIds.length).toBe(1)
    const hostAIds = store.matchLabel('host', 'a')
    expect(hostAIds.length).toBe(2)
    const noMatch = store.matchLabel('__name__', 'disk')
    expect(noMatch.length).toBe(0)
  })

  it('queries time range subset', () => {
    const store = new FlatStore()
    const ts = [1000n, 2000n, 3000n, 4000n, 5000n]
    const vals = [10, 20, 30, 40, 50]
    pushSamples(store, CPU_LABELS, ts, vals)

    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 2000n, 4000n)
    expect(data.timestamps.length).toBe(3)
    expect(data.timestamps[0]).toBe(2000n)
    expect(data.timestamps[2]).toBe(4000n)
    expect(data.values[0]).toBeCloseTo(20)
    expect(data.values[2]).toBeCloseTo(40)
  })

  it('returns empty result for out-of-range query', () => {
    const store = new FlatStore()
    pushSample(store, CPU_LABELS, 1000n, 42.5)

    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 5000n, 9000n)
    expect(data.timestamps.length).toBe(0)
    expect(data.values.length).toBe(0)
  })

  it('deduplicates series with same labels', () => {
    const store = new FlatStore()
    const id1 = store.getOrCreateSeries(CPU_LABELS)
    const id2 = store.getOrCreateSeries(new Map([['__name__', 'cpu'], ['host', 'a']]))
    expect(id1).toBe(id2)
    expect(store.seriesCount).toBe(1)
  })

  it('deduplicates regardless of label insertion order', () => {
    const store = new FlatStore()
    const id1 = store.getOrCreateSeries(new Map([['host', 'a'], ['__name__', 'cpu']]))
    const id2 = store.getOrCreateSeries(new Map([['__name__', 'cpu'], ['host', 'a']]))
    expect(id1).toBe(id2)
    expect(store.seriesCount).toBe(1)
  })

  it('tracks sample and series counts', () => {
    const store = new FlatStore()
    pushSamples(store, CPU_LABELS, [1000n, 2000n], [1, 2])
    pushSample(store, MEM_LABELS, 1000n, 3.0)
    expect(store.seriesCount).toBe(2)
    expect(store.sampleCount).toBe(3)
  })

  it('reports memoryBytes > 0 after data is added', () => {
    const store = new FlatStore()
    pushSample(store, CPU_LABELS, 1000n, 42.5)
    expect(store.memoryBytes()).toBeGreaterThan(0)
  })

  it('returns labels for a series', () => {
    const store = new FlatStore()
    const id = pushSample(store, CPU_LABELS, 1000n, 42.5)
    const labels = store.labels(id)
    expect(labels.get('__name__')).toBe('cpu')
    expect(labels.get('host')).toBe('a')
  })
})

// ── ChunkedStore ─────────────────────────────────────────────────────

describe('ChunkedStore', () => {
  it('creates store with correct name', () => {
    const store = new ChunkedStore()
    expect(store.name).toBe('ChunkedStore')
  })

  it('pushes and reads back data', () => {
    const store = new ChunkedStore()
    pushSample(store, CPU_LABELS, 1000n, 42.5)
    pushSample(store, CPU_LABELS, 2000n, 43.0)

    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 0n, 10000n)
    expect(data.timestamps.length).toBe(2)
    expect(data.timestamps[0]).toBe(1000n)
    expect(data.values[0]).toBeCloseTo(42.5)
  })

  it('queries time range subset', () => {
    const store = new ChunkedStore()
    const ts = [1000n, 2000n, 3000n, 4000n, 5000n]
    const vals = [10, 20, 30, 40, 50]
    pushSamples(store, CPU_LABELS, ts, vals)

    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 2000n, 4000n)
    expect(data.timestamps.length).toBe(3)
    expect(data.values[1]).toBeCloseTo(30)
  })

  it('freezes chunks when exceeding chunkSize', () => {
    const chunkSize = 10
    const store = new ChunkedStore(chunkSize)
    const baseTs = 1_000_000_000_000n
    const ts = []
    const vals = []
    for (let i = 0; i < 25; i++) {
      ts.push(baseTs + BigInt(i) * 1000n)
      vals.push(i * 1.0)
    }
    pushSamples(store, CPU_LABELS, ts, vals)

    const ids = store.matchLabel('__name__', 'cpu')
    const info = store.getChunkInfo(ids[0])
    // 25 samples / 10 chunkSize = 2 frozen chunks + 5 in hot
    expect(info.frozen.length).toBe(2)
    expect(info.hot.count).toBe(5)
    expect(info.frozen[0].count).toBe(10)
    expect(info.frozen[1].count).toBe(10)
  })

  it('reads data spanning frozen and hot chunks', () => {
    const chunkSize = 5
    const store = new ChunkedStore(chunkSize)
    const ts = []
    const vals = []
    for (let i = 0; i < 12; i++) {
      ts.push(BigInt(i + 1) * 1000n)
      vals.push((i + 1) * 10.0)
    }
    pushSamples(store, CPU_LABELS, ts, vals)

    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 0n, 100000n)
    expect(data.timestamps.length).toBe(12)
    // Verify ordering across chunks
    for (let i = 0; i < 12; i++) {
      expect(data.timestamps[i]).toBe(BigInt(i + 1) * 1000n)
      expect(data.values[i]).toBeCloseTo((i + 1) * 10.0)
    }
  })

  it('tracks memoryBytes including compressed chunks', () => {
    const chunkSize = 5
    const store = new ChunkedStore(chunkSize)
    const ts = []
    const vals = []
    for (let i = 0; i < 10; i++) {
      ts.push(BigInt(i) * 1000n)
      vals.push(i * 1.0)
    }
    pushSamples(store, CPU_LABELS, ts, vals)

    const bytes = store.memoryBytes()
    expect(bytes).toBeGreaterThan(0)
  })

  it('deduplicates series with same labels', () => {
    const store = new ChunkedStore()
    const id1 = store.getOrCreateSeries(CPU_LABELS)
    const id2 = store.getOrCreateSeries(new Map([['__name__', 'cpu'], ['host', 'a']]))
    expect(id1).toBe(id2)
    expect(store.seriesCount).toBe(1)
  })

  it('deduplicates regardless of label insertion order', () => {
    const store = new ChunkedStore()
    const id1 = store.getOrCreateSeries(new Map([['host', 'a'], ['__name__', 'cpu']]))
    const id2 = store.getOrCreateSeries(new Map([['__name__', 'cpu'], ['host', 'a']]))
    expect(id1).toBe(id2)
  })

  it('compression ratio improves with regular data', () => {
    const chunkSize = 50
    const store = new ChunkedStore(chunkSize)
    const ts = []
    const vals = []
    for (let i = 0; i < 50; i++) {
      ts.push(BigInt(i) * 1_000_000_000n)
      vals.push(42.5) // all same value → great compression
    }
    pushSamples(store, CPU_LABELS, ts, vals)

    const ids = store.matchLabel('__name__', 'cpu')
    const info = store.getChunkInfo(ids[0])
    expect(info.frozen.length).toBe(1)
    const rawBytes = info.frozen[0].rawBytes
    const compressedBytes = info.frozen[0].compressedBytes
    expect(compressedBytes).toBeLessThan(rawBytes)
  })

  it('returns empty result for out-of-range query', () => {
    const store = new ChunkedStore()
    pushSample(store, CPU_LABELS, 1000n, 42.5)
    const ids = store.matchLabel('__name__', 'cpu')
    const data = store.read(ids[0], 5000n, 9000n)
    expect(data.timestamps.length).toBe(0)
  })
})
