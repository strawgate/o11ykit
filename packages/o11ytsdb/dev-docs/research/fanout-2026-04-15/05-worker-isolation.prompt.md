# Worker Isolation & Zero-Copy Transfer Architecture

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Prototype the web worker isolation architecture for o11ytsdb: design the message protocol, measure transfer overhead for different strategies (structured clone, Transferable, SharedArrayBuffer), and build a working proof-of-concept that moves the TSDB into a worker with minimal main-thread impact.

## Why this workstream exists

o11ytsdb is designed to run in the browser. The M8 milestone calls for worker isolation so that:

- Ingest and compression don't block the UI thread
- Query execution runs off-thread
- The WASM instance lives in the worker (avoids main-thread memory pressure)
- Chart rendering on the main thread gets pre-aggregated data

The key architectural tension: **zero-copy** (SharedArrayBuffer) is powerful but requires COOP/COEP headers and has security implications. **Transferable** ArrayBuffers are widely supported but move ownership (source loses the data). **Structured clone** is simple but copies data. We need decision-grade evidence on which to use.

## Mode

**prototype + benchmark**

## Required execution checklist

- You MUST read these files first:
  - `packages/o11ytsdb/PLAN.md` (M8 section)
  - `packages/o11ytsdb/src/types.ts` (StorageBackend, QueryEngine interfaces)
  - `packages/o11ytsdb/src/index.ts` (current public API)
  - `packages/o11ytsdb/src/column-store.ts` (ColumnStore internals — what data needs transferring)

- You MUST implement:
  1. **Message Protocol** (`src/worker-protocol.ts`):
     - Define typed message envelopes: `IngestMessage`, `QueryMessage`, `QueryResultMessage`, `ErrorMessage`
     - Request/response correlation (request IDs)
     - Serialization strategy per message type
  2. **Worker Entry Point** (`src/worker.ts`):
     - Instantiate ColumnStore + WASM codec inside worker
     - Handle ingest messages: parse OTLP, insert into store
     - Handle query messages: execute query, return results
     - Handle lifecycle: init, destroy, memory stats
  3. **Main-Thread Client** (`src/worker-client.ts`):
     - `O11yWorkerClient` class wrapping the worker
     - Async methods: `ingest(payload)`, `query(opts)`, `memoryStats()`
     - Automatic request/response correlation
     - Timeout handling
  4. **Transfer Strategy Benchmarks**:
     - Benchmark three strategies for returning query results (BigInt64Array + Float64Array):
       a. **Structured clone**: postMessage with default serialization
       b. **Transferable**: postMessage with transfer list (ArrayBuffer ownership moves)
       c. **SharedArrayBuffer**: pre-allocated shared ring buffer
     - Measure for various result sizes: 1K, 10K, 100K, 1M samples
     - Measure: transfer latency, main-thread blocking time, memory overhead
  5. **Unit tests**: message protocol roundtrip, worker lifecycle, query result correctness

- You MUST measure and report:
  - Round-trip latency (main→worker→main) for each transfer strategy at each size
  - Main-thread frame impact (simulated: how long does the main thread block?)
  - Memory overhead of each strategy
  - Whether SharedArrayBuffer requires COOP/COEP and what the fallback should be

- You MUST end with a recommendation:
  - `USE_TRANSFERABLE` — best balance of compatibility and performance
  - `USE_SHARED` — SharedArrayBuffer is worth the header requirements
  - `USE_HYBRID` — SharedArrayBuffer when available, Transferable fallback
  - `USE_STRUCTURED_CLONE` — overhead is negligible, simplicity wins

- After completing the required work, explore:
  - Whether a ring-buffer protocol over SharedArrayBuffer could enable streaming query results
  - Comlink or similar RPC libraries — are they worth the dependency?
  - Whether WASM memory can be shared between workers

## Deliverable

Write implementation at:
- `packages/o11ytsdb/src/worker-protocol.ts` — message types and serialization
- `packages/o11ytsdb/src/worker.ts` — worker entry point
- `packages/o11ytsdb/src/worker-client.ts` — main-thread client
- `packages/o11ytsdb/bench/worker-transfer.bench.ts` — transfer strategy benchmarks

Write a research memo at:
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/05-worker-isolation-results.md`

The memo must include:
- Transfer latency table (strategy × size)
- Main-thread blocking measurements
- Memory overhead comparison
- COOP/COEP implications analysis
- Recommendation label (one of the four above)
- Architecture diagram of the final worker protocol

## Constraints

- Ground everything in the actual repo code
- No external RPC/worker libraries (Comlink etc.) for the prototype — evaluate but don't depend
- Must work in modern browsers (Chrome 90+, Firefox 90+, Safari 15+)
- SharedArrayBuffer path must detect availability and fall back gracefully
- Worker must be tree-shakeable (importable as a separate entry point, not bundled with main)
- The worker prototype should work with Node.js worker_threads for testing
