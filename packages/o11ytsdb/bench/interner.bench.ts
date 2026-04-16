import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Suite, printReport } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = (rel: string) => join(__dirname, "..", "..", rel);

function makeStrings(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`service_${i}:region_${i % 31}:env_${i % 3}`);
  return out;
}

export default async function runInternerBench() {
  const suite = new Suite("interner");
  const strings = makeStrings(10_000);

  const { Interner } = await import(pkgPath("dist/interner.js"));
  const tsInterner = new Interner();

  suite.add("intern_10k", "ts", () => {
    for (const s of strings) tsInterner.intern(s);
  }, { iterations: 200, itemsPerCall: strings.length });

  suite.add("resolve_10k", "ts", () => {
    for (let i = 0; i < strings.length; i++) tsInterner.resolve(i);
  }, { iterations: 300, itemsPerCall: strings.length });

  const rawUtf16Bytes = strings.reduce((sum, s) => sum + s.length * 2, 0);
  suite.addCompression("string_memory", "ts", strings.length, rawUtf16Bytes, tsInterner.memoryBytes());

  try {
    const wasmBytes = readFileSync(pkgPath("wasm/o11ytsdb-rust.wasm"));
    const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {} });
    const wasm = instance.exports as unknown as {
      memory: WebAssembly.Memory;
      internerReset: () => void;
      internerIntern: (ptr: number, len: number) => number;
    };
    if (wasm.internerReset && wasm.internerIntern) {
      const encoder = new TextEncoder();
      wasm.internerReset();
      suite.add("intern_10k", "rust-wasm", () => {
        const mem = new Uint8Array(wasm.memory.buffer);
        for (const s of strings) {
          const bytes = encoder.encode(s);
          mem.set(bytes, 0);
          wasm.internerIntern(0, bytes.length);
        }
      }, { iterations: 200, itemsPerCall: strings.length });

      const checkTs = new Interner();
      wasm.internerReset();
      const mem = new Uint8Array(wasm.memory.buffer);
      let valid = true;
      for (const s of strings.slice(0, 2000)) {
        const bytes = encoder.encode(s);
        mem.set(bytes, 0);
        if (checkTs.intern(s) !== wasm.internerIntern(0, bytes.length)) {
          valid = false;
          break;
        }
      }
      suite.addValidation("ts", "rust-wasm", "same-id-sequence", valid, valid ? "matched" : "mismatch");
    }
  } catch (err: any) {
    suite.addValidation("ts", "rust-wasm", "same-id-sequence", false, `skipped: ${err.message ?? err}`);
  }

  const report = suite.run();
  printReport(report);
  return report;
}
