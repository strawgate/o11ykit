#!/usr/bin/env node
/**
 * Split a monolithic OTLP JSONL file into per-category files.
 *
 * Usage:
 *   node bench/split-otel.mjs [input.jsonl]
 *
 * Produces:
 *   bench/data/process.jsonl   — process.* metrics (few series, deep)
 *   bench/data/cpu.jsonl       — system.cpu.* metrics (many series, shallow)
 *   bench/data/infra.jsonl     — everything else (disk/mem/net/fs/paging/load)
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] || join(__dirname, "data/host-metrics.jsonl");

const writers = {
  process: createWriteStream(join(__dirname, "data/process.jsonl")),
  cpu: createWriteStream(join(__dirname, "data/cpu.jsonl")),
  infra: createWriteStream(join(__dirname, "data/infra.jsonl")),
};

function classify(metricName) {
  if (metricName.startsWith("process.")) return "process";
  if (metricName.startsWith("system.cpu.")) return "cpu";
  return "infra";
}

const rl = createInterface({
  input: createReadStream(input, { encoding: "utf-8" }),
  crlfDelay: Infinity,
});

const stats = { process: 0, cpu: 0, infra: 0 };

for await (const line of rl) {
  if (!line) continue;
  const batch = JSON.parse(line);

  // For each resourceMetrics entry, split its metrics into categories
  // and write separate lines per category. Each rm has its own resource
  // (e.g., different processes), so we preserve that structure.
  for (const rm of batch.resourceMetrics ?? []) {
    const catMetrics = { process: [], cpu: [], infra: [] };

    for (const sm of rm.scopeMetrics ?? []) {
      // Group this scope's metrics by category.
      const byCat = { process: [], cpu: [], infra: [] };
      for (const m of sm.metrics ?? []) {
        byCat[classify(m.name)].push(m);
      }
      for (const cat of ["process", "cpu", "infra"]) {
        if (byCat[cat].length > 0) {
          catMetrics[cat].push({ scope: sm.scope, metrics: byCat[cat] });
        }
      }
    }

    // Write one line per category that had metrics for this resource.
    for (const [cat, scopeMetrics] of Object.entries(catMetrics)) {
      if (scopeMetrics.length === 0) continue;
      const out = {
        resourceMetrics: [{
          resource: rm.resource,
          scopeMetrics,
          schemaUrl: "https://opentelemetry.io/schemas/1.9.0",
        }],
      };
      writers[cat].write(JSON.stringify(out) + "\n");
      stats[cat]++;
    }
  }
}

// Close all writers.
for (const w of Object.values(writers)) {
  w.end();
}

console.log("Split complete:");
for (const [cat, count] of Object.entries(stats)) {
  console.log(`  ${cat.padEnd(10)} ${count} batches → bench/data/${cat}.jsonl`);
}
