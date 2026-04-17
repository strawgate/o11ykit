/**
 * TSDB Benchmark Orchestrator
 *
 * Runs the full benchmark pipeline:
 *   1. Generate synthetic OTLP metrics
 *   2. Ingest into Prometheus, VictoriaMetrics, and Mimir
 *   3. Measure storage efficiency
 *   4. Run PromQL query benchmarks
 *   5. Generate comparison report
 *
 * Usage:
 *   npx tsx src/index.ts                    # full benchmark
 *   npx tsx src/index.ts --phase ingest     # single phase
 *   npx tsx src/index.ts --series 1000      # override series count
 */

import { DEFAULT_CONFIG, TARGETS, type BenchConfig } from "./config.js";
import { generateOtlpRequests, describeWorkload } from "./generator.js";
import { ingestToAll, waitForData } from "./ingest.js";
import { measureStorage } from "./measure-storage.js";
import { runQueryBenchmark } from "./query-bench.js";
import { generateReport } from "./report.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "results");

function parseArgs(): { phase?: string; config: BenchConfig } {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };
  let phase: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--phase":
        phase = args[++i];
        break;
      case "--series":
        config.seriesCount = parseInt(args[++i], 10);
        break;
      case "--samples":
        config.samplesPerSeries = parseInt(args[++i], 10);
        break;
      case "--iterations":
        config.queryIterations = parseInt(args[++i], 10);
        break;
      case "--batch-size":
        config.batchSize = parseInt(args[++i], 10);
        break;
      case "--help":
        console.log(`
TSDB Benchmark — Compare Prometheus, VictoriaMetrics, and Mimir

Usage: npx tsx src/index.ts [options]

Options:
  --phase <name>     Run a single phase: generate, ingest, storage, query, report
  --series <n>       Number of series per metric type (default: ${DEFAULT_CONFIG.seriesCount})
  --samples <n>      Samples per series (default: ${DEFAULT_CONFIG.samplesPerSeries})
  --iterations <n>   Query benchmark iterations (default: ${DEFAULT_CONFIG.queryIterations})
  --batch-size <n>   OTLP requests batch size (default: ${DEFAULT_CONFIG.batchSize})
  --help             Show this help

Prerequisites:
  docker compose up -d   (from benchmarks/tsdb-comparison/)
`);
        process.exit(0);
    }
  }

  return { phase, config };
}

async function main() {
  const { phase, config } = parseArgs();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TSDB Benchmark: Prometheus vs VictoriaMetrics vs Mimir");
  console.log("═══════════════════════════════════════════════════════════");

  const workload = describeWorkload(config);
  console.log(`\nWorkload:`);
  console.log(`  Series per metric type: ${workload.seriesCount}`);
  console.log(`  Samples per series:     ${workload.samplesPerSeries}`);
  console.log(`  Metric types:           ${workload.metricTypes}`);
  console.log(`  Total data points:      ${workload.totalDataPoints.toLocaleString()}`);
  console.log(`  Time range:             ${workload.timeRangeMinutes} minutes`);
  console.log(`  Export requests:        ${workload.estimatedRequests}`);

  // ── Phase 1: Generate ──
  if (!phase || phase === "generate" || phase === "ingest") {
    console.log("\n── Phase 1: Generating OTLP payloads ──");
    const t0 = performance.now();
    var requests = generateOtlpRequests(config);
    const genTime = performance.now() - t0;
    console.log(
      `  Generated ${requests.length} requests in ${(genTime / 1000).toFixed(1)}s`
    );
  }

  // ── Phase 2: Ingest ──
  let ingestResults;
  if (!phase || phase === "ingest") {
    console.log("\n── Phase 2: Ingesting to TSDBs ──");
    ingestResults = await ingestToAll(TARGETS, requests!, config);
    await waitForData(TARGETS);
  }

  // ── Phase 3: Storage ──
  let storageResults;
  if (!phase || phase === "storage") {
    console.log("\n── Phase 3: Measuring Storage ──");
    storageResults = await measureStorage(TARGETS);
  }

  // ── Phase 4: Query Benchmark ──
  let queryResults;
  if (!phase || phase === "query") {
    console.log("\n── Phase 4: Query Benchmark ──");
    queryResults = await runQueryBenchmark(TARGETS, config);
  }

  // ── Phase 5: Report ──
  if (!phase || phase === "report") {
    console.log("\n── Phase 5: Generating Report ──");

    const report = generateReport(
      config,
      storageResults ?? [],
      queryResults ?? [],
      ingestResults ?? [],
    );

    mkdirSync(OUTPUT_DIR, { recursive: true });

    const mdPath = join(OUTPUT_DIR, "benchmark-report.md");
    writeFileSync(mdPath, report.markdown);
    console.log(`  ✓ Markdown report: ${mdPath}`);

    const jsonPath = join(OUTPUT_DIR, "benchmark-report.json");
    writeFileSync(jsonPath, JSON.stringify(report.json, null, 2));
    console.log(`  ✓ JSON report: ${jsonPath}`);

    // Print to stdout
    console.log("\n" + report.markdown);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Benchmark complete!");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
