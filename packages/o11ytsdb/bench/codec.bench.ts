/**
 * M1 Codec benchmark — pluggable multi-runtime.
 *
 * Each codec implementation registers against the CodecImpl interface.
 * The benchmark runs all registered implementations against the same
 * test vectors, cross-validates pairwise, and reports throughput,
 * compression, and memory side-by-side.
 *
 * To add a new implementation:
 *   1. Import your encode/decode functions
 *   2. Push a CodecImpl onto the `implementations` array
 *   3. The harness handles the rest
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchReport, Runtime } from "./harness.js";
import { printReport, Suite } from "./harness.js";
import type { ChunkData } from "./vectors.js";
import { allGenerators } from "./vectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a path relative to the package root (two levels up from bench/dist/). */
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

// ── Pluggable codec interface ────────────────────────────────────────

export interface CodecImpl {
  /** Runtime tag for reporting. */
  runtime: Runtime;
  /** Display name. */
  name: string;
  /** Encode timestamps + values → compressed bytes. */
  encode(timestamps: BigInt64Array, values: Float64Array): Uint8Array;
  /** Decode compressed bytes → timestamps + values. */
  decode(buf: Uint8Array): { timestamps: BigInt64Array; values: Float64Array };
}

// ── Implementation registry ──────────────────────────────────────────
// Add new implementations here. The benchmark is data-driven from this.

const implementations: CodecImpl[] = [];

// TypeScript implementation.
try {
  const tsPath = pkgPath("dist/codec.js");
  const ts = await import(tsPath);
  implementations.push({
    runtime: "ts",
    name: "TypeScript",
    encode: ts.encodeChunk,
    decode: ts.decodeChunk,
  });
} catch (_e) {
  console.log("  ⚠ TS codec not built — skipping. Run `npm run build` first.");
}

// Zig WASM implementation.
try {
  const { loadWasm, makeCodecImpl } = await import("./wasm-loader.js");
  const zigWasmPath = pkgPath("wasm/o11ytsdb-zig.wasm");
  const zigWasm = await loadWasm(zigWasmPath);
  implementations.push(makeCodecImpl(zigWasm, "zig", "Zig→WASM"));
} catch (e: any) {
  console.log(`  ⚠ Zig WASM codec not available — skipping. ${e.message ?? e}`);
}

// Rust WASM implementation.
try {
  const { loadWasm, makeCodecImpl } = await import("./wasm-loader.js");
  const rustWasmPath = pkgPath("wasm/o11ytsdb-rust.wasm");
  const rustWasm = await loadWasm(rustWasmPath);
  implementations.push(makeCodecImpl(rustWasm, "rust", "Rust→WASM"));
} catch (e: any) {
  console.log(`  ⚠ Rust WASM codec not available — skipping. ${e.message ?? e}`);
}

// ── Correctness: round-trip within a single implementation ───────────

function verifyRoundTrip(impl: CodecImpl, data: ChunkData): { ok: boolean; detail: string } {
  const encoded = impl.encode(data.timestamps, data.values);
  const decoded = impl.decode(encoded);

  if (decoded.timestamps.length !== data.timestamps.length) {
    return {
      ok: false,
      detail: `length mismatch: ${decoded.timestamps.length} vs ${data.timestamps.length}`,
    };
  }

  for (let i = 0; i < data.timestamps.length; i++) {
    if (decoded.timestamps[i] !== data.timestamps[i]) {
      return {
        ok: false,
        detail: `ts[${i}]: got ${decoded.timestamps[i]}, want ${data.timestamps[i]}`,
      };
    }
    if (decoded.values[i] !== data.values[i]) {
      if (!(Number.isNaN(decoded.values[i]) && Number.isNaN(data.values[i]))) {
        return {
          ok: false,
          detail: `val[${i}]: got ${decoded.values[i]}, want ${data.values[i]}`,
        };
      }
    }
  }

  return { ok: true, detail: "bit-exact" };
}

// ── Cross-validation: A encodes → B decodes ─────────────────────────

function crossValidate(
  implA: CodecImpl,
  implB: CodecImpl,
  data: ChunkData
): { ok: boolean; detail: string } {
  const encoded = implA.encode(data.timestamps, data.values);
  let decoded: { timestamps: BigInt64Array; values: Float64Array };
  try {
    decoded = implB.decode(encoded);
  } catch (e) {
    return { ok: false, detail: `${implB.runtime} failed to decode ${implA.runtime} output: ${e}` };
  }

  if (decoded.timestamps.length !== data.timestamps.length) {
    return {
      ok: false,
      detail: `length: ${decoded.timestamps.length} vs ${data.timestamps.length}`,
    };
  }

  for (let i = 0; i < data.timestamps.length; i++) {
    if (decoded.timestamps[i] !== data.timestamps[i]) {
      return { ok: false, detail: `ts[${i}]: ${decoded.timestamps[i]} vs ${data.timestamps[i]}` };
    }
    if (decoded.values[i] !== data.values[i]) {
      if (!(Number.isNaN(decoded.values[i]) && Number.isNaN(data.values[i]))) {
        return { ok: false, detail: `val[${i}]: ${decoded.values[i]} vs ${data.values[i]}` };
      }
    }
  }

  return { ok: true, detail: "bit-exact" };
}

// ── Main ─────────────────────────────────────────────────────────────

export default async function (): Promise<BenchReport> {
  if (implementations.length === 0) {
    console.log("  ✗ No codec implementations available. Build first.");
    throw new Error("No implementations");
  }

  const suite = new Suite("codec");
  const generators = allGenerators(1024);

  console.log(`  Implementations: ${implementations.map((i) => i.name).join(", ")}\n`);

  // ── Self round-trip verification ──
  console.log("  ── Round-trip correctness ──\n");
  for (const impl of implementations) {
    for (const gen of generators) {
      const result = verifyRoundTrip(impl, gen);
      const mark = result.ok ? "✓" : "✗";
      console.log(`    ${mark} ${impl.runtime}/${gen.name}: ${result.detail}`);
    }
  }
  console.log();

  // ── Cross-validation (pairwise: A→encode, B→decode) ──
  if (implementations.length > 1) {
    console.log("  ── Cross-validation ──\n");
    for (let a = 0; a < implementations.length; a++) {
      for (let b = 0; b < implementations.length; b++) {
        if (a === b) continue;
        const implA = implementations[a]!;
        const implB = implementations[b]!;
        for (const gen of generators) {
          const result = crossValidate(implA, implB, gen);
          const mark = result.ok ? "✓" : "✗";
          console.log(
            `    ${mark} ${implA.runtime}→encode, ${implB.runtime}→decode [${gen.name}]: ${result.detail}`
          );
          suite.addValidation(implA.runtime, implB.runtime, gen.name, result.ok, result.detail);
        }
      }
    }
    console.log();
  }

  // ── Compression ratios ──
  for (const impl of implementations) {
    for (const gen of generators) {
      const encoded = impl.encode(gen.timestamps, gen.values);
      const rawBytes = gen.timestamps.length * 16;
      suite.addCompression(gen.name, impl.runtime, gen.timestamps.length, rawBytes, encoded.length);
    }
  }

  // ── Encode benchmarks ──
  for (const impl of implementations) {
    for (const gen of generators) {
      suite.add(
        `encode_${gen.name}`,
        impl.runtime,
        () => {
          impl.encode(gen.timestamps, gen.values);
        },
        {
          unit: "samples/sec",
          itemsPerCall: gen.timestamps.length,
          iterations: 500,
        }
      );
    }
  }

  // ── Decode benchmarks ──
  for (const impl of implementations) {
    const encodedBuffers = generators.map((gen) => ({
      name: gen.name,
      buf: impl.encode(gen.timestamps, gen.values),
      len: gen.timestamps.length,
    }));

    for (const { name, buf, len } of encodedBuffers) {
      suite.add(
        `decode_${name}`,
        impl.runtime,
        () => {
          impl.decode(buf);
        },
        {
          unit: "samples/sec",
          itemsPerCall: len,
          iterations: 500,
        }
      );
    }
  }

  // ── Memory: encode+decode 10K iterations and measure heap ──
  for (const impl of implementations) {
    const gen = generators.find((g) => g.name === "gauge_2dp");
    if (!gen) throw new Error("Missing benchmark vector: gauge_2dp");
    suite.add(
      `memory_encode_1024x1000`,
      impl.runtime,
      () => {
        // Encode 1024 points. Measures allocation pressure.
        impl.encode(gen.timestamps, gen.values);
      },
      {
        unit: "ops/sec",
        iterations: 1000,
        warmup: 50,
      }
    );
  }

  const report = suite.run();
  printReport(report);
  return report;
}
