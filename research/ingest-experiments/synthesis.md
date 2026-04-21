# Ingest Performance Experiments — Synthesis

> Historical note: these experiments predate `RowGroupStore` becoming the
> canonical packed backend. References to `FlatStore`, `ChunkedStore`, and
> `ColumnStore` reflect the repository state at the time of the fanout.

## Inputs

5 Codex Cloud experiments on branch `copilot/improving-ingest-performance`, run against the 10× optimized TS baseline (1.20M pts/sec p50, 10K gauge points):

| # | Experiment | Attempts | Status | GitHub Issue |
|---|-----------|----------|--------|-------------|
| 1 | flattenAttributes bypass | 2 | ✅ READY | #100 |
| 2 | Direct-to-storage flush | 2 | ✅ READY | #99 |
| 3 | Schema-specialized codegen | 1 | ✅ READY | #102 |
| 4 | Worker-offloaded ingest | 2 | ✅ READY | #101 |
| 5 | WASM ingest | 3 | ✅ READY | #103 |

All tasks completed with diffs and results docs.

---

## Results Summary

| Experiment | Verdict | Key Metric | Complexity |
|-----------|---------|-----------|-----------|
| **flatten bypass** | **ADOPT** | +12% p50, +29% p99 | Low — clean refactor |
| **direct-to-storage** | **ADOPT (selective)** | ~8-11% flush improvement | Medium — optional API extension |
| **codegen** | DEFER | 1.74× when shape matches | High — deopt risk, maintenance cost |
| **worker ingest** | OPTIONAL | 90% less main-thread blocking | Medium — needs backpressure |
| **WASM** | DEFER | 3-4× slower than TS currently | High — needs single-pass scanner redesign |

---

## Convergence

Both attempts on each multi-attempt task converged on the same approach and direction:

- **flatten bypass**: Both attempts added `forEachAttribute()` to `@otlpkit/otlpjson`, removed `cachedFlattenAttributes` from ingest. Attempt 1 was the stronger result (+12% p50 vs +4%).
- **direct-flush**: Both attempts prototyped reserve-and-write. Attempt 2 also tested streaming append-per-sample (surprisingly competitive on FlatStore).
- **worker**: Both attempts implemented the same protocol extension. Attempt 1 measured more carefully (separate main-thread blocking metric).

## Disagreements

- **direct-flush attempt 2** found append-per-sample slightly beat reserve-and-write on FlatStore (+7% vs +1.5%), while attempt 1 only tested reserve-and-write. This is FlatStore-specific and may not generalize to other packed backends.
- **worker attempt 1** measured 550K sync vs 280K worker throughput; attempt 2 measured 187K sync vs 154K worker. The absolute numbers vary wildly across cloud runner environments, but the relative pattern holds: worker halves throughput while dramatically cutting main-thread blocking.
- **WASM attempt 1** extracted the most careful crossover analysis and showed no crossover up to 20K points. The other attempts concurred.

## Repo Fit

### flatten bypass — Excellent fit
- `forEachAttribute()` is a natural extension to `@otlpkit/otlpjson`. Clean callback-based API, no new dependencies, backward compatible. Both attempts updated ingest.ts identically. Removes the `cachedFlattenAttributes` complexity. Tests added.

### direct-to-storage — Good fit with caveats
- `StorageBackend.reserveBatch()` is optional, backward-compatible. Only needs implementation in stores where it's beneficial. However, the reserve/commit contract needs documentation and debug assertions. The `pending` Map → flat array iteration optimization (from attempt 2) is a simpler, orthogonal win worth pursuing independently.

### codegen — Poor fit for now
- `new Function()` approach introduces V8 deopt sensitivity and debugging difficulty. The 43ms shape-detection overhead amortizes only after ~15 batches of the same shape. Real workload shape stability is unknown. Not production-ready without telemetry on shape-repeat rates.

### worker ingest — Good fit as opt-in
- Builds on the existing WorkerClient/O11yWorkerRuntime architecture. The protocol extension is clean. However, it needs backpressure controls before becoming default. Main value is UI responsiveness, not throughput.

### WASM — Not ready
- The prototype proves feasibility and excellent binary size (2.8KB!), but the naive scanner is 3-4× slower than optimized TS. The JS→WASM boundary (TextEncoder + copy) adds another 24% overhead. A production WASM ingest module needs a fundamentally different single-pass scanner architecture.

## Evidence Quality

| Experiment | Quality | Notes |
|-----------|---------|-------|
| flatten bypass | **Decision-grade** | Both attempts measured same benchmark; attempt 1 showed clear +12% p50 |
| direct-flush | **Directional** | Reserve-and-write shows ~8-11% flush improvement, but measured in isolation, not E2E with parse. Cloud runner variability affects absolute numbers. |
| codegen | **Directional** | 1.74× is promising but measured in a custom harness, not the production benchmark. Shape stability assumption untested. |
| worker | **Decision-grade** | Both attempts clearly demonstrate the main-thread blocking reduction (90%+ decrease). Throughput trade-off well characterized. |
| WASM | **Decision-grade** | Clear negative result — TS wins handily at this payload size. Crossover not observed up to 20K points. |

---

## Recommendations

### Adopt now

1. **flatten bypass** — Apply attempt 1 diff. Adds `forEachAttribute()` to otlpjson, removes cachedFlattenAttributes from ingest, passes point.attributes directly. +12% p50, +29% p99. Low risk, clean code improvement.

2. **worker ingest (as opt-in)** — Apply attempt 1 diff. Adds `ingest` operation to worker protocol. Keep sync path as default; expose `WorkerClient.ingest()` for UI-facing usage. Follow up with backpressure controls.

### Adopt selectively

3. **direct-to-storage reserve-and-write** — Apply to FlatStore as optional fast path. Also extract the `pending` Map → flat array iteration pattern from attempt 2 as a separate, simpler optimization.

### Defer

4. **codegen** — Add shape-stability instrumentation to generic ingest path first. If real workloads show 80%+ shape-repeat rates, revisit.

5. **WASM** — Revisit only if/when a true single-pass schema-aware scanner is built (not substring search). The 2.8KB binary size proves the packaging story works; the parser needs a complete rewrite.

---

## Next Steps

1. **Apply flatten bypass** (attempt 1) — straightforward merge, test, benchmark locally
2. **Apply worker ingest** (attempt 1) — merge protocol/runtime/client changes, add backpressure TODO
3. **Apply reserve-and-write** to FlatStore — merge attempt 1's optional API extension
4. **Extract pending iteration optimization** from direct-flush attempt 2 as separate change
5. **Add shape-stability counter** to ingest metrics for codegen feasibility data
6. **Close WASM experiment** — file follow-up issue for single-pass scanner when ready
7. **Run combined benchmark** — stack flatten bypass + reserve-and-write + pending iteration together and measure cumulative improvement
