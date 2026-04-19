# Worker-Offloaded Ingest Prototype Results

Date: 2026-04-19 (UTC)
Benchmark script: `research/ingest-experiments/04-worker-bench.mjs`

## Summary metrics (10,000-point OTLP batch, 15 iterations)

- **Sync ingest on main thread**
  - p50 main-thread blocking: **18.87 ms**
  - p50 ingest wall time: **18.18 ms**
  - throughput: **~550,018 points/sec**
- **Worker ingest (payload transferred as `Uint8Array` transferable)**
  - p50 main-thread blocking: **1.92 ms**
  - p50 round-trip latency: **35.66 ms**
  - throughput: **~280,400 points/sec**

## Interpretation

1. **Main-thread jank is substantially reduced**.
   - Moving parse + flush into the worker cut p50 main-thread blocking from ~19ms to ~1.9ms.
   - This is materially better for 60fps UI workloads.

2. **End-to-end ingest latency increases**.
   - Worker path adds postMessage encode/decode and queueing overhead.
   - p50 RTT rose from ~18.2ms equivalent sync wall-time to ~35.7ms.

3. **Throughput decreases significantly in this prototype**.
   - ~49% lower throughput versus direct sync ingest in this environment.
   - Trade-off appears acceptable if UI responsiveness is the priority.

## Prototype behavior checks

- Worker `ingest` now returns the same `IngestResult` shape as synchronous `ingestOtlpJson`.
- Existing point-column ingestion remains available as worker `append`.
- Errors from worker ingest are propagated to the caller via worker error envelopes.

## Exploration notes

### SharedArrayBuffer for zero-copy reads

- `SharedArrayBuffer` can reduce copy overhead for payload handoff and, in theory, for query read paths.
- However, **storage internals are mutable and index-heavy**, so direct SAB-based zero-copy reads likely need:
  - fixed-layout buffers,
  - atomic synchronization,
  - and a versioning protocol to avoid torn reads.
- Feasible for specialized hot paths, but not a drop-in replacement for current storage objects.

### Backpressure when producer outpaces worker

- Current `WorkerClient` does not apply queue bounds.
- If batches arrive faster than ingest rate, pending promises and queued messages can grow unbounded.
- Recommended follow-up:
  - add max in-flight request count,
  - expose queue depth metrics,
  - optionally implement drop/coalesce strategy for bursty producers.

### Could `append()` be replaced by worker `ingest()`?

- Not fully.
- `append()` is lower-level and already structured for pre-parsed columnar samples.
- `ingest()` (OTLP JSON) is higher-level and incurs parse/serialization overhead.
- They should coexist: `append()` for low-latency preprocessed pipelines, `ingest()` for convenience and UI-isolation.

## Recommendation

**OPTIONAL**

Make worker-offloaded OTLP ingest an opt-in default for browser/UI-facing usage, but keep sync/append paths for max throughput and server-like contexts. Promote to full default only after adding explicit backpressure controls and more browser-device benchmarks.
