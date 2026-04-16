import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FlatStore } from '../src/flat-store.js';
import { ingestOtlpJson } from '../src/ingest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const file = join(__dirname, 'fixtures', name);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

describe('o11ytsdb ingestOtlpJson', () => {
  it('ingests all OTLP metric kinds and batch-inserts samples', () => {
    const fixture = loadFixture('otlp-sample.json');
    const storage = new FlatStore();

    const result = ingestOtlpJson(fixture, storage);

    expect(result.pointsSeen).toBe(7);
    expect(result.errors).toBe(1);
    expect(result.metricTypeCounts).toEqual({
      gauge: 1,
      sum: 1,
      histogram: 1,
      summary: 1,
      exponentialHistogram: 1,
    });

    // 2 valid gauge + 1 sum + (3 buckets + count + sum) + (2 quantiles + count + sum)
    // + (3 exp buckets + zero + count + sum)
    expect(result.samplesInserted).toBe(18);
    expect(storage.sampleCount).toBe(18);
    expect(storage.seriesCount).toBeGreaterThanOrEqual(10);

    const cpuIds = storage.matchLabel('__name__', 'system.cpu.utilization');
    expect(cpuIds).toHaveLength(1);
    const cpu = storage.read(cpuIds[0]!, 0n, 3_000_000_000_000_000_000n);
    expect(cpu.values).toHaveLength(2);

    // First timestamp was provided in milliseconds and should be normalized to nanos.
    expect(cpu.timestamps[0]).toBe(1_710_000_000_000_000_000n);

    const histBucketIds = storage.matchLabel('__name__', 'http.server.duration_bucket');
    expect(histBucketIds.length).toBeGreaterThan(0);
    const hasLeBucket = histBucketIds
      .map((id) => storage.labels(id))
      .some((labels) => labels?.has('le'));
    expect(hasLeBucket).toBe(true);

    const expIds = storage.matchLabel('__name__', 'queue.delay_bucket');
    expect(expIds.length).toBeGreaterThan(0);
    const hasZeroBucket = expIds
      .map((id) => storage.labels(id))
      .some((labels) => labels?.get('exp_bucket') === 'zero');
    expect(hasZeroBucket).toBe(true);
  });

  it('accepts JSON string payloads and rejects malformed/unsupported payloads gracefully', () => {
    const fixture = loadFixture('otlp-sample.json');
    const storage = new FlatStore();

    const good = ingestOtlpJson(JSON.stringify(fixture), storage);
    expect(good.samplesInserted).toBeGreaterThan(0);

    const badJson = ingestOtlpJson('{not valid', storage);
    expect(badJson.errors).toBe(1);
    expect(badJson.samplesInserted).toBe(0);

    const wrongSignal = ingestOtlpJson({ resourceSpans: [] }, storage);
    expect(wrongSignal.errors).toBe(1);
    expect(wrongSignal.samplesInserted).toBe(0);
  });
});
