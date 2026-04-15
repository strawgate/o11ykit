# String Interner + Inverted Index (M2 + M3)

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Implement M2 (String Interner) and M3 (Inverted Index / MemPostings) as defined in the PLAN.md roadmap, delivering an 8× memory savings on label storage and O(1) label→series lookup with galloping set intersection.

## Why this workstream exists

Currently, o11ytsdb stores labels as `Map<string, string>` per series, and label lookups are linear scans (`matchLabel` iterates all series). For 10K+ series, this is the dominant memory and query bottleneck. The roadmap identifies:

- **M2**: FNV-1a string interner — deduplicate label keys/values into a single typed-array–backed table
- **M3**: MemPostings — inverted index from `(label, value)` → sorted `SeriesId[]` with galloping intersection

These two modules are tightly coupled and should be built together.

## Mode

**implementation + benchmark**

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/PLAN.md` (M2 and M3 sections in detail)
  - `packages/o11ytsdb/src/types.ts` (Labels, SeriesId, StorageBackend)
  - `packages/o11ytsdb/src/flat-store.ts` (current label storage — Map<string, string>)
  - `packages/o11ytsdb/src/column-store.ts` (group-by label logic)
  - `packages/o11ytsdb/src/query.ts` (ScanEngine label matching)
  - `packages/o11ytsdb/bench/harness.ts` (benchmark infrastructure)

- You MUST implement:
  1. **String Interner** (`src/interner.ts`):
     - FNV-1a 32-bit hash, open-addressing hash table
     - Backed by `Uint8Array` (UTF-8 bytes) + `Uint32Array` (offsets) — no JS string retention
     - `intern(s: string): InternId` — returns u32 id
     - `resolve(id: InternId): string` — returns original string
     - `bulkIntern(strings: string[]): Uint32Array` — batch operation
     - Target: <200 ns/intern, <50 ns/resolve
  2. **Inverted Index** (`src/postings.ts`):
     - `MemPostings` class
     - `add(seriesId: SeriesId, labels: Labels): void`
     - `get(label: string, value: string): SeriesId[]` — returns sorted array
     - `intersect(a: SeriesId[], b: SeriesId[]): SeriesId[]` — galloping intersection
     - `union(a: SeriesId[], b: SeriesId[]): SeriesId[]`
     - `matchRegex(label: string, pattern: RegExp): SeriesId[]`
  3. **Integration**: Update `StorageBackend` implementations to use the interner + postings
  4. **Unit tests**: hash collision handling, bulk intern correctness, intersection edge cases, regex matching
  5. **Benchmarks** (`bench/interner.bench.ts`, `bench/postings.bench.ts`):
     - Intern throughput (ops/sec) for realistic label cardinality (10K unique strings)
     - Memory: bytes per interned string vs raw JS string overhead
     - Intersection throughput: galloping vs naive for various set sizes
     - Full query: label match + intersection for 10K series

- You MUST also implement a WASM version of the interner in either Zig or Rust (pick whichever you find cleaner based on reading the existing Zig/Rust codec code), targeting <3 KB WASM binary addition
- You MUST cross-validate TS and WASM interner implementations (same strings → same ids)

- After completing the required work, use your judgment to explore:
  - Bloom filter pre-screening for high-cardinality labels
  - Adaptive hash table resizing strategies
  - Whether interning the full label set as a composite key helps

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/interner.ts` — string interner
- `packages/o11ytsdb/src/postings.ts` — inverted index
- `packages/o11ytsdb/bench/interner.bench.ts` — interner benchmarks
- `packages/o11ytsdb/bench/postings.bench.ts` — postings benchmarks
- Unit tests in appropriate test files

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/02-interner-postings-results.md`

The memo must include:
- Intern throughput (TS vs WASM)
- Memory savings vs raw Map<string, string> at 10K series
- Galloping intersection throughput at various set sizes (100, 1K, 10K)
- Label match + query speedup vs current linear scan
- Recommendation: which implementation to ship

## Constraints

- Ground everything in the actual repo code
- No external dependencies
- WASM interner must follow the existing calling convention (linear memory, pointer passing)
- Interner must handle UTF-8 correctly (OTel labels can be arbitrary UTF-8)
- Hash table must gracefully handle 100K+ unique strings without pathological collisions
