#!/usr/bin/env node

/**
 * o11ytsdb benchmark runner.
 *
 * Usage:
 *   node bench/run.mjs                # Run all benchmarks
 *   node bench/run.mjs codec          # Run codec benchmarks only
 *   node bench/run.mjs --compare file # Compare against baseline JSON
 *
 * Output:
 *   - ASCII table to stdout
 *   - JSON report to bench/results/{module}-{timestamp}.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(__dirname, 'results');

const args = process.argv.slice(2);
const moduleFilter = args.find(a => !a.startsWith('--'));
const compareFile = args.includes('--compare')
  ? args[args.indexOf('--compare') + 1]
  : undefined;

// Ensure results directory exists.
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true });
}

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  o11ytsdb benchmark suite                           ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log();

if (moduleFilter) {
  console.log(`  Filter: ${moduleFilter}`);
} else {
  console.log('  Running all modules');
}
console.log();

// Module registry — add each module's bench file as it's built.
// Each value is a path to the compiled .js bench module in bench/dist/.
// The module must export a default async function that returns a BenchReport.
const modules = {
  'codec': './dist/codec.bench.js',
  'competitive': './dist/competitive.bench.js',
  // 'interner': './dist/interner.bench.js',
  // 'postings': './dist/postings.bench.js',
  // 'ingest': './dist/ingest.bench.js',
  // 'query': './dist/query.bench.js',
};

const available = Object.keys(modules);
if (available.length === 0) {
  console.log('  No benchmark modules registered yet.');
  console.log('  Benchmarks will be added as each module passes its gate.');
  console.log();
  console.log('  Harness is ready. Run `npm run bench:build` to compile bench files.');
  console.log();
  console.log('  To add a benchmark module:');
  console.log('    1. Create bench/<module>.bench.ts');
  console.log('    2. Import { bench, runAll, printReport } from "./harness.js"');
  console.log('    3. Register with `export default async function() { ... }`');
  console.log('    4. Uncomment the entry in bench/run.mjs modules map');
  process.exit(0);
}

// Run each matching module.
const { compareReports } = await import('./dist/harness.js');
const allReports = [];

for (const [name, path] of Object.entries(modules)) {
  if (moduleFilter && name !== moduleFilter) continue;

  console.log(`\n  ─── ${name} ───\n`);
  try {
    const mod = await import(path);
    const report = await mod.default();
    allReports.push(report);

    // Write JSON result.
    const outFile = join(resultsDir, `${name}-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`  → ${outFile}`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err.message);
  }
}

// Compare against baseline if requested.
if (compareFile && allReports.length > 0) {
  console.log(`\n  ─── Comparison against ${compareFile} ───\n`);
  try {
    const baseline = JSON.parse(readFileSync(compareFile, 'utf-8'));
    for (const report of allReports) {
      const { passed, regressions } = compareReports(baseline, report);
      if (passed) {
        console.log(`  ✓ ${report.module}: no regressions`);
      } else {
        console.log(`  ✗ ${report.module}: REGRESSIONS DETECTED`);
        for (const r of regressions) console.log(`    - ${r}`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(`  ✗ Failed to load baseline:`, err.message);
    process.exitCode = 1;
  }
}
