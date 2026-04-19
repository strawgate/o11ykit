# Experiment: worker-offloaded ingest pipeline

You are handling one workstream inside a larger Codex Cloud fanout for this repository.

## Objective

Prototype moving the entire OTLP ingest pipeline (parse + flush) to a Web Worker so the main thread never blocks during data ingestion. Integrate with the existing `WorkerClient` / `O11yWorkerRuntime` architecture.

## Why this workstream exists

Even at 1.2M pts/sec, ingesting a 10K-point batch blocks the calling thread for ~10ms. For browser applications rendering at 60fps (16ms frame budget), this is significant. Large batches or slower devices could cause visible jank. The codebase already has a worker architecture for query operations — ingest should use it too.

## Mode

prototype

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/src/worker.ts` — the existing O11yWorkerRuntime, understand how it handles messages
  - `packages/o11ytsdb/src/worker-client.ts` — the WorkerClient that the main thread uses
  - `packages/o11ytsdb/src/worker-protocol.ts` — the message protocol types
  - `packages/o11ytsdb/src/ingest.ts` — the ingest pipeline
  - `packages/o11ytsdb/src/types.ts` — StorageBackend interface
  - `packages/o11ytsdb/test/worker-runtime.test.ts` — existing worker tests
- You MUST implement a prototype that:
  1. Adds an `ingest` operation to the worker protocol (`worker-protocol.ts`)
  2. Handles `ingest` in the worker runtime (`worker.ts`) — calls `ingestOtlpJson` or `parseOtlpToSamples` + `flushSamplesToStorage` inside the worker
  3. Adds an `ingest()` method to `WorkerClient` that sends the payload and returns `Promise<IngestResult>`
  4. Handles payload transfer efficiently (the JSON string should be transferred, not structured-cloned)
- You MUST write tests for the worker ingest path
- You MUST benchmark main-thread-blocking time before and after:
  - Create a benchmark at `research/ingest-experiments/04-worker-bench.mjs` that measures:
    - Time the main thread is blocked during ingest (sync path)
    - Round-trip time for worker ingest (async path)
    - Whether throughput changes
- You MUST write results to `research/ingest-experiments/04-worker-ingest-results.md`

After completing the required work, explore:
- Whether `SharedArrayBuffer` would allow zero-copy reads from the worker's storage
- Backpressure: what happens if batches arrive faster than the worker can process them
- Whether the existing `WorkerClient.append()` operation could be replaced by this

## Required repo context

Read at least these:

- `packages/o11ytsdb/src/worker.ts`
- `packages/o11ytsdb/src/worker-client.ts`
- `packages/o11ytsdb/src/worker-protocol.ts`
- `packages/o11ytsdb/src/ingest.ts`
- `packages/o11ytsdb/src/types.ts`
- `packages/o11ytsdb/test/worker-runtime.test.ts`

Key context:
- The worker protocol uses `postMessage` with typed request/response objects
- `WorkerClient` wraps a Web Worker (or mock) with promise-based request/response
- The worker runtime creates its own `StorageBackend` instance — storage lives in the worker
- Query operations (`scan`, `query`) already go through the worker
- `ingestOtlpJson(payload, storage)` is the convenience function that does parse+flush in one call
- `ingestOtlpObject(document, storage)` skips JSON.parse for pre-validated payloads
- The worker test uses a mock `MessagePort` — follow the same pattern

## Deliverable

1. Modified worker protocol, runtime, and client files (or separate experimental files if you prefer not to modify production code)
2. Tests for the worker ingest path
3. Benchmark at `research/ingest-experiments/04-worker-bench.mjs`
4. Results at `research/ingest-experiments/04-worker-ingest-results.md`

## Constraints

- Do NOT break existing worker operations (query, scan, append)
- Do NOT introduce new dependencies
- The worker ingest must return the same `IngestResult` as the synchronous path
- Handle errors gracefully — if ingest fails in the worker, the error must propagate to the caller
- Consider that `JSON.parse` in the worker is fine — the point is to move ALL blocking work off the main thread, including parsing

## Success criteria

- Worker ingest produces identical results to synchronous ingest
- Tests pass (existing + new)
- Benchmark shows near-zero main thread blocking for the worker path
- Results doc discusses throughput trade-offs and latency overhead from postMessage
- Clear recommendation on whether this should be the default ingest path

## Decision style

End with a clear recommendation: ADOPT (make this the default), OPTIONAL (offer as an opt-in API), or DEFER (not enough value).
