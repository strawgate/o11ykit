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

export class ScanEngine {
  query(storage, opts) {
    let ids = storage.matchLabel("__name__", opts.metric);
    if (opts.matchers) {
      for (const m of opts.matchers) {
        const s = new Set(storage.matchLabel(m.label, m.value));
        ids = ids.filter((id) => s.has(id));
      }
    }
    let scannedSamples = 0;
    if (!opts.agg) {
      const series = [];
      for (const id of ids) {
        const data = storage.read(id, opts.start, opts.end);
        scannedSamples += data.timestamps.length;
        series.push({
          labels: storage.labels(id) ?? new Map(),
          timestamps: data.timestamps,
          values: data.values,
        });
      }
      return { series, scannedSeries: ids.length, scannedSamples };
    }

    const groups = new Map();
    for (const id of ids) {
      const data = storage.read(id, opts.start, opts.end);
      scannedSamples += data.timestamps.length;
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
      const result = this._aggregate(group.ranges, opts.agg, opts.step);
      series.push({ labels: group.labels, timestamps: result.timestamps, values: result.values });
    }
    return { series, scannedSeries: ids.length, scannedSamples };
  }

  _aggregate(ranges, fn, step) {
    if (ranges.length === 0)
      return { timestamps: new BigInt64Array(0), values: new Float64Array(0) };
    if (!step) return this._pointAggregate(ranges, fn);
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
    for (const r of ranges) {
      if (r.timestamps.length === 0) continue;
      if (r.timestamps[0] < minT) minT = r.timestamps[0];
      if (r.timestamps[r.timestamps.length - 1] > maxT)
        maxT = r.timestamps[r.timestamps.length - 1];
    }
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
}
