# Experiment: direct-to-storage flush — eliminate intermediate copy

> Historical note: this prompt predates `RowGroupStore` becoming the canonical
> packed backend. Backend references below describe the repository state when
> the experiment was commissioned.

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype a "reserve and write" API for `StorageBackend` that lets the ingest pipeline write timestamps and values directly into the store's typed arrays, eliminating the intermediate `number[]` accumulation + `BigInt64Array`/`Float64Array` copy at flush time.

## Why this workstream exists

After three rounds of ingest optimization (10× speedup to 1.20M pts/sec), the flush phase now accounts for ~50% of E2E time (4.8ms of 9.7ms for 10K points). The current data path has unnecessary copies:

1. During parse: timestamps accumulate into `number[]`, values into `number[]` (Array.push per point)
2. At flush: `BigInt64Array` is constructed from `number[]` (ms→ns conversion loop), `Float64Array.from()` copies values
3. `storage.appendBatch()` copies again into the store's own growing typed arrays

Steps 1+2 are a double copy that could be eliminated if ingest wrote directly into storage buffers.

## Mode

prototype

## Required execution checklist

- You MUST read these files before changing anything:
  - `packages/o11ytsdb/src/types.ts` — the `StorageBackend` interface, especially `append`, `appendBatch`, and the internal buffer structures
  - `packages/o11ytsdb/src/flat-store.ts` — the simplest storage backend, to understand how `appendBatch` works internally (grow-by-doubling BigInt64Array + Float64Array)
  - `packages/o11ytsdb/src/ingest.ts` — the `flushSamplesToStorage` function and how `PendingSeriesSamples` accumulates data
  - `packages/o11ytsdb/src/chunked-store.ts` — another store to understand the interface contract
- You MUST prototype at least one of these approaches:
  1. **Reserve-and-write**: Add `reserveBatch(id, count)` returning writable slices. Ingest writes directly. Flush just commits the length.
  2. **Streaming append**: Instead of accumulating into PendingSeriesSamples, call `storage.append(id, ts, value)` per sample during parse (eliminating the pending map entirely). This only works if append is cheap enough.
  3. **Pre-allocated column buffers**: Replace `number[]` with pre-sized `Float64Array` per series in PendingSeriesSamples, grow-by-doubling. Flush transfers the typed arrays directly to storage.
- You MUST benchmark all approaches you try against the current implementation
- You MUST run tests: `npx vitest run packages/o11ytsdb/test/`
- You MUST write results to `research/ingest-experiments/02-direct-flush-results.md`
- You MUST include a clear recommendation on which approach (if any) is worth pursuing

After completing the required work, explore whether the `pending` Map can be replaced with a flat array for better iteration performance at flush time.

## Required repo context

Read at least these:

- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/src/flat-store.ts`
- `packages/o11ytsdb/src/ingest.ts`
- `packages/o11ytsdb/src/chunked-store.ts`

Key context:
- `PendingSeriesSamples` has `timestamps: number[]` (milliseconds) and `values: number[]`
- `flushSamplesToStorage` converts ms→ns via `BigInt(msArr[i]) * 1_000_000n` and creates `Float64Array.from(batch.values)`
- FlatStore stores each series as `{ timestamps: BigInt64Array, values: Float64Array, count: number }` with grow-by-doubling
- ChunkedStore accumulates into a chunk buffer then compresses
- The `StorageBackend` interface is a public API — any changes should be backward-compatible (add new methods, don't break existing ones)
- ~256 unique series in the benchmark workload, ~39 samples per series for 10K points

## Deliverable

1. Prototype code (can be a separate experimental file or modifications to existing files)
2. Results at `research/ingest-experiments/02-direct-flush-results.md` with:
   - Benchmark numbers for each approach tried
   - Analysis of which copy is actually most expensive
   - Clear recommendation

## Constraints

- Do NOT break the existing `StorageBackend` interface — add new methods, don't modify existing signatures
- Do NOT change the public API of `parseOtlpToSamples` (it must still return `ParsedOtlpResult`)
- Keep the prototype focused on FlatStore — don't modify ChunkedStore/ColumnStore unless needed for tests
- Measure flush time separately from parse time to isolate the improvement

## Success criteria

- At least one approach benchmarked with clear numbers
- Results doc explains why each approach did or didn't work
- If there's a win, it's measurable in the E2E benchmark (even 5-10% is interesting for the flush phase)
- Clear recommendation on next steps
