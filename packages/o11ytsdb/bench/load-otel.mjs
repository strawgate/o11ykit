#!/usr/bin/env node
/**
 * OTLP JSONL → benchmark data loader.
 *
 * Parses the file exporter output from otelcol-contrib and produces
 * per-series { labels, timestamps, values } arrays suitable for the
 * profile / sweep / compress-test harnesses.
 *
 * Usage:
 *   import { loadOtelData } from './load-otel.mjs';
 *   const series = await loadOtelData('bench/data/host-metrics.jsonl');
 *   // series[i] = { labels: Map<string,string>, timestamps: BigInt64Array, values: Float64Array }
 *
 * Standalone:
 *   node bench/load-otel.mjs [path]   # prints summary
 */

import { readFileSync, existsSync, createReadStream } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build a stable series key from metric name + sorted attribute pairs.
 * This identifies a unique time series across batches.
 */
function seriesKey(metricName, attrs) {
  const parts = [metricName];
  for (const a of attrs) {
    const v = a.value;
    const val = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? "";
    parts.push(`${a.key}=${val}`);
  }
  return parts.join("|");
}

/**
 * Extract the numeric value from a datapoint.
 * OTLP uses asDouble for floats and asInt (string-encoded int64) for integers.
 */
function dpValue(dp) {
  if (dp.asDouble !== undefined) return dp.asDouble;
  if (dp.asInt !== undefined) return Number(dp.asInt);
  return 0;
}

/**
 * Load OTLP JSONL file and return an array of series.
 *
 * @param {string} path  Path to the JSONL file.
 * @param {object} opts
 * @param {number} [opts.minPoints=2]  Drop series with fewer points than this.
 * @param {number} [opts.repeat=1]  Repeat data N times with shifted timestamps.
 * @returns {{ labels: Map<string,string>, timestamps: BigInt64Array, values: Float64Array }[]}
 */
export async function loadOtelData(path, opts = {}) {
  const { minPoints = 2, repeat = 1 } = opts;

  // Auto-decompress: if the .jsonl doesn't exist, look for .zst in the testdata repo.
  if (!existsSync(path)) {
    const name = basename(path);
    const zst = join(dirname(path), ".testdata-repo", "o11ytsdb", `${name}.zst`);
    if (existsSync(zst)) {
      console.log(`  Decompressing ${name} from testdata repo…`);
      execFileSync("zstd", ["-d", zst, "-o", path]);
    } else {
      throw new Error(
        `${path} not found. Run ./bench/fetch-testdata.sh to download testdata.`
      );
    }
  }

  // Stream line-by-line to avoid V8 string size limits on large files.
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  // Accumulate per-series: { labels: Map, points: [{ ts, val }] }
  const seriesMap = new Map();

  for await (const line of rl) {
    if (!line) continue;
    const batch = JSON.parse(line);
    for (const rm of batch.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const name = m.name;
          const kind = m.gauge ? "gauge" : m.sum ? "sum" : m.histogram ? "histogram" : null;
          if (!kind) continue;
          const dataPoints = m[kind].dataPoints ?? [];
          for (const dp of dataPoints) {
            const attrs = dp.attributes ?? [];
            const key = seriesKey(name, attrs);

            if (!seriesMap.has(key)) {
              const labels = new Map([["__name__", name]]);
              for (const a of attrs) {
                const v = a.value;
                labels.set(a.key, String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? ""));
              }
              seriesMap.set(key, { labels, points: [] });
            }

            const ts = BigInt(dp.timeUnixNano);
            const val = dpValue(dp);
            seriesMap.get(key).points.push({ ts, val });
          }
        }
      }
    }
  }

  // Convert to typed arrays, sorted by timestamp, deduplicated.
  const result = [];
  for (const [, entry] of seriesMap) {
    // Sort by timestamp.
    entry.points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    // Deduplicate (same timestamp = keep last value).
    const deduped = [];
    for (let i = 0; i < entry.points.length; i++) {
      if (i > 0 && entry.points[i].ts === entry.points[i - 1].ts) {
        deduped[deduped.length - 1] = entry.points[i];
      } else {
        deduped.push(entry.points[i]);
      }
    }

    if (deduped.length < minPoints) continue;

    const timestamps = new BigInt64Array(deduped.length);
    const values = new Float64Array(deduped.length);
    for (let i = 0; i < deduped.length; i++) {
      timestamps[i] = deduped[i].ts;
      values[i] = deduped[i].val;
    }
    result.push({ labels: entry.labels, timestamps, values });
  }

  // Sort series by name then label cardinality for stable ordering.
  result.sort((a, b) => {
    const na = a.labels.get("__name__") ?? "";
    const nb = b.labels.get("__name__") ?? "";
    if (na !== nb) return na < nb ? -1 : 1;
    return a.labels.size - b.labels.size;
  });

  if (repeat <= 1) return result;

  // Repeat: concatenate N copies with timestamps shifted end-to-end.
  // Find global time range across all series.
  let globalMin = result[0].timestamps[0];
  let globalMax = result[0].timestamps[result[0].timestamps.length - 1];
  for (const s of result) {
    if (s.timestamps[0] < globalMin) globalMin = s.timestamps[0];
    if (s.timestamps[s.timestamps.length - 1] > globalMax) globalMax = s.timestamps[s.timestamps.length - 1];
  }
  // Shift each repeat by (duration + 15s gap) so timestamps never overlap.
  const duration = globalMax - globalMin;
  const gap = 15_000_000_000n; // 15s in nanos
  const stride = duration + gap;

  const repeated = [];
  for (const s of result) {
    const n = s.timestamps.length;
    const totalLen = n * repeat;
    const ts = new BigInt64Array(totalLen);
    const vals = new Float64Array(totalLen);
    for (let r = 0; r < repeat; r++) {
      const shift = stride * BigInt(r);
      const off = r * n;
      for (let i = 0; i < n; i++) {
        ts[off + i] = s.timestamps[i] + shift;
        vals[off + i] = s.values[i];
      }
    }
    repeated.push({ labels: s.labels, timestamps: ts, values: vals });
  }
  return repeated;
}

// ── Standalone summary ───────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("load-otel.mjs")) {
  const repeatIdx = process.argv.indexOf("--repeat");
  const repeat = repeatIdx >= 0 ? Number(process.argv[repeatIdx + 1]) : 1;
  const args = process.argv.filter((a, i) => a !== "--repeat" && (repeatIdx < 0 || i !== repeatIdx + 1));
  const path = args[2] || join(__dirname, "data/host-metrics.jsonl");
  const series = await loadOtelData(path, { repeat });

  const totalPts = series.reduce((s, x) => s + x.timestamps.length, 0);
  const ptsPerSeries = series.map(s => s.timestamps.length);
  const minPts = Math.min(...ptsPerSeries);
  const maxPts = Math.max(...ptsPerSeries);
  const medPts = ptsPerSeries.sort((a, b) => a - b)[Math.floor(ptsPerSeries.length / 2)];

  // Unique metric names.
  const metricNames = new Set(series.map(s => s.labels.get("__name__")));

  console.log(`\n  OTLP data loaded from: ${path}\n`);
  console.log(`  Series:       ${series.length}`);
  console.log(`  Metric names: ${metricNames.size}`);
  console.log(`  Total points: ${totalPts.toLocaleString()}`);
  console.log(`  Points/series: min=${minPts} median=${medPts} max=${maxPts}`);

  // Time range.
  let globalMin = series[0].timestamps[0];
  let globalMax = series[0].timestamps[series[0].timestamps.length - 1];
  for (const s of series) {
    if (s.timestamps[0] < globalMin) globalMin = s.timestamps[0];
    if (s.timestamps[s.timestamps.length - 1] > globalMax) globalMax = s.timestamps[s.timestamps.length - 1];
  }
  const durationMs = Number(globalMax - globalMin) / 1e6;
  const durationMin = durationMs / 60000;
  console.log(`  Time range:   ${durationMin.toFixed(1)} minutes`);

  // Per metric name breakdown.
  const byName = new Map();
  for (const s of series) {
    const name = s.labels.get("__name__");
    if (!byName.has(name)) byName.set(name, { count: 0, pts: 0 });
    byName.get(name).count++;
    byName.get(name).pts += s.timestamps.length;
  }
  console.log(`\n  Per-metric breakdown:`);
  for (const [name, info] of [...byName.entries()].sort((a, b) => b[1].pts - a[1].pts)) {
    console.log(`    ${name.padEnd(45)} ${String(info.count).padStart(4)} series  ${info.pts.toLocaleString().padStart(8)} pts`);
  }

  // Sample values from first few series.
  console.log(`\n  Sample values (first 3 series):`);
  for (const s of series.slice(0, 3)) {
    const name = s.labels.get("__name__");
    const first5 = Array.from(s.values.slice(0, 5)).map(v => v.toFixed(4)).join(", ");
    console.log(`    ${name}: [${first5}, ...] (${s.timestamps.length} pts)`);
  }
  console.log("");
}
