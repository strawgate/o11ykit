// ── Query Engine ─────────────────────────────────────────────────────

function aggInit(fn) {
  if (fn === "min") return Infinity;
  if (fn === "max") return -Infinity;
  return 0;
}

function aggAccum(acc, v, fn) {
  switch (fn) {
    case "sum":
    case "avg":
      return acc + v;
    case "min":
      return v < acc ? v : acc;
    case "max":
      return v > acc ? v : acc;
    case "count":
      return acc + 1;
    case "last":
      return v;
    default:
      return acc;
  }
}

function aggFinalize(vals, counts, fn) {
  if (fn === "avg") for (let i = 0; i < vals.length; i++) if (counts[i] > 0) vals[i] /= counts[i];
}

function isPercentile(fn) {
  return fn === "p50" || fn === "p95" || fn === "p99";
}

function percentileFraction(fn) {
  if (fn === "p50") return 0.5;
  if (fn === "p95") return 0.95;
  if (fn === "p99") return 0.99;
  return null;
}

function resolveStep(step, start, end, maxPoints) {
  if (!maxPoints || maxPoints < 2) return step;
  const rangeNs = end - start;
  if (rangeNs <= 0) return step;

  const bucketCount = BigInt(Math.max(1, maxPoints - 1));
  const derivedStep = (rangeNs + bucketCount - 1n) / bucketCount;
  if (!step) return derivedStep;
  return step < derivedStep ? derivedStep : step;
}

/** Apply a per-series transform (rate/irate/delta/increase) to a raw data range. */
function applyTransform(data, transform) {
  const { timestamps, values } = data;
  const n = timestamps.length;
  if (n < 2) return data;

  const outValues = new Float64Array(n);
  outValues[0] = 0;

  for (let i = 1; i < n; i++) {
    const dtNs = Number(timestamps[i] - timestamps[i - 1]);
    const dtSec = dtNs / 1_000_000_000;
    const dv = values[i] - values[i - 1];

    switch (transform) {
      case "rate": {
        const delta = dv >= 0 ? dv : values[i]; // counter reset: use current value
        outValues[i] = dtSec > 0 ? delta / dtSec : 0;
        break;
      }
      case "irate": {
        const delta = dv >= 0 ? dv : values[i];
        outValues[i] = dtSec > 0 ? delta / dtSec : 0;
        break;
      }
      case "delta":
        outValues[i] = dv;
        break;
      case "increase":
        outValues[i] = dv >= 0 ? dv : values[i]; // counter reset
        break;
      default:
        outValues[i] = values[i];
    }
  }
  return { timestamps, values: outValues };
}

export class ScanEngine {
  query(storage, opts) {
    let ids = storage.matchLabel("__name__", opts.metric);

    // Apply matchers
    if (opts.matchers && opts.matchers.length > 0) {
      for (const m of opts.matchers) {
        if (m.op === "!=" || m.op === "not=") {
          const excluded = new Set(storage.matchLabel(m.label, m.value));
          ids = ids.filter((id) => !excluded.has(id));
        } else {
          // Default: exact match (=)
          const matched = new Set(storage.matchLabel(m.label, m.value));
          ids = ids.filter((id) => matched.has(id));
        }
      }
    }

    let scannedSamples = 0;
    const effectiveStep =
      opts.start !== undefined && opts.end !== undefined
        ? resolveStep(opts.step, opts.start, opts.end, opts.maxPoints)
        : opts.step;

    // No aggregation: just return raw series (with optional transform)
    if (!opts.agg) {
      const series = [];
      for (const id of ids) {
        let data = storage.read(id, opts.start, opts.end);
        scannedSamples += data.timestamps.length;
        if (opts.transform) data = applyTransform(data, opts.transform);
        series.push({
          labels: storage.labels(id) ?? new Map(),
          timestamps: data.timestamps,
          values: data.values,
        });
      }
      return {
        series,
        scannedSeries: ids.length,
        scannedSamples,
        requestedStep: opts.step ?? null,
        effectiveStep,
        pointBudget: opts.maxPoints ?? null,
      };
    }

    // Aggregation path
    const groups = new Map();
    for (const id of ids) {
      let data = storage.read(id, opts.start, opts.end);
      scannedSamples += data.timestamps.length;
      if (opts.transform) data = applyTransform(data, opts.transform);

      const labels = storage.labels(id) ?? new Map();
      const groupKey = opts.groupBy
        ? opts.groupBy.map((k) => labels.get(k) ?? "").join("\0")
        : "__all__";
      let group = groups.get(groupKey);
      if (!group) {
        const gl = new Map();
        gl.set("__name__", opts.metric);
        if (opts.groupBy)
          for (const k of opts.groupBy) {
            const v = labels.get(k);
            if (v) gl.set(k, v);
          }
        group = { labels: gl, ranges: [] };
        groups.set(groupKey, group);
      }
      group.ranges.push(data);
    }

    const series = [];
    for (const [, group] of groups) {
      const result = this._aggregate(group.ranges, opts.agg, effectiveStep);
      series.push({ labels: group.labels, timestamps: result.timestamps, values: result.values });
    }
    return {
      series,
      scannedSeries: ids.length,
      scannedSamples,
      requestedStep: opts.step ?? null,
      effectiveStep,
      pointBudget: opts.maxPoints ?? null,
    };
  }

  _aggregate(ranges, fn, step) {
    if (ranges.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (!step) return this._pointAggregate(ranges, fn);
    if (isPercentile(fn)) return this._percentileStepAggregate(ranges, fn, step);
    return this._stepAggregate(ranges, fn, step);
  }

  _pointAggregate(ranges, fn) {
    let longest = ranges[0];
    for (const r of ranges) if (r.timestamps.length > longest.timestamps.length) longest = r;
    const timestamps = longest.timestamps;
    const values = new Float64Array(timestamps.length);

    if (fn === "rate") {
      const src = ranges[0];
      for (let i = 1; i < src.timestamps.length; i++) {
        const dt = Number(src.timestamps[i] - src.timestamps[i - 1]) / 1_000_000;
        values[i] = dt > 0 ? (src.values[i] - src.values[i - 1]) / (dt / 1000) : 0;
      }
      return { timestamps, values };
    }
    if (isPercentile(fn)) {
      // Collect all values per timestamp position, then pick percentile
      const frac = percentileFraction(fn);
      for (let i = 0; i < timestamps.length; i++) {
        const bucket = [];
        for (const r of ranges) if (i < r.values.length) bucket.push(r.values[i]);
        if (bucket.length === 0) continue;
        bucket.sort((a, b) => a - b);
        const idx = Math.floor(frac * (bucket.length - 1));
        values[i] = bucket[idx];
      }
      return { timestamps, values };
    }
    values.fill(aggInit(fn));
    const counts = new Float64Array(timestamps.length);
    for (const r of ranges) {
      const len = Math.min(r.values.length, timestamps.length);
      for (let i = 0; i < len; i++) {
        values[i] = aggAccum(values[i], r.values[i], fn);
        counts[i]++;
      }
    }
    aggFinalize(values, counts, fn);
    return { timestamps, values };
  }

  _stepAggregate(ranges, fn, step) {
    let minT = BigInt("9223372036854775807");
    let maxT = -minT;
    let hasSamples = false;

    for (const r of ranges) {
      if (r.timestamps.length === 0) continue;
      hasSamples = true;
      if (r.timestamps[0] < minT) minT = r.timestamps[0];
      if (r.timestamps[r.timestamps.length - 1] > maxT)
        maxT = r.timestamps[r.timestamps.length - 1];
    }

    if (!hasSamples) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };

    const bucketCount = Number((maxT - minT) / step) + 1;
    const timestamps = new BigInt64Array(bucketCount);
    const values = new Float64Array(bucketCount);
    const counts = new Float64Array(bucketCount);
    for (let i = 0; i < bucketCount; i++) timestamps[i] = minT + BigInt(i) * step;
    values.fill(aggInit(fn));

    for (const r of ranges) {
      for (let i = 0; i < r.timestamps.length; i++) {
        const bucket = Number((r.timestamps[i] - minT) / step);
        if (bucket < 0 || bucket >= bucketCount) continue;
        values[bucket] = aggAccum(values[bucket], r.values[i], fn);
        counts[bucket]++;
      }
    }
    aggFinalize(values, counts, fn);
    return { timestamps, values };
  }

  _percentileStepAggregate(ranges, fn, step) {
    const frac = percentileFraction(fn);
    let minT = BigInt("9223372036854775807");
    let maxT = -minT;
    let hasSamples = false;
    for (const r of ranges) {
      if (r.timestamps.length === 0) continue;
      hasSamples = true;
      if (r.timestamps[0] < minT) minT = r.timestamps[0];
      if (r.timestamps[r.timestamps.length - 1] > maxT)
        maxT = r.timestamps[r.timestamps.length - 1];
    }
    if (!hasSamples) return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };

    const bucketCount = Number((maxT - minT) / step) + 1;
    const timestamps = new BigInt64Array(bucketCount);
    const buckets = Array.from({ length: bucketCount }, () => []);
    for (let i = 0; i < bucketCount; i++) timestamps[i] = minT + BigInt(i) * step;

    for (const r of ranges) {
      for (let i = 0; i < r.timestamps.length; i++) {
        const bucket = Number((r.timestamps[i] - minT) / step);
        if (bucket < 0 || bucket >= bucketCount) continue;
        buckets[bucket].push(r.values[i]);
      }
    }

    const values = new Float64Array(bucketCount);
    for (let i = 0; i < bucketCount; i++) {
      const b = buckets[i];
      if (b.length === 0) continue;
      b.sort((a, c) => a - c);
      const idx = Math.floor(frac * (b.length - 1));
      values[i] = b[idx];
    }
    return { timestamps, values };
  }
}
