# Worker Isolation & Zero-Copy Transfer Architecture

You are handling one workstream inside a larger Codex Cloud fanout for the o11ytsdb package — a browser-native time-series database for OpenTelemetry data.

## Objective

Prototype the web worker isolation architecture for o11ytsdb: design the message protocol, measure transfer overhead for different strategies (structured clone, Transferable, SharedArrayBuffer), and build a working proof-of-concept.

## Why this workstream exists

o11ytsdb is designed to run in the browser. The M8 milestone calls for worker isolation so that ingest/compression don't block the UI thread, query execution runs off-thread, and the WASM instance lives in the worker.

The key tension: **zero-copy** (SharedArrayBuffer) requires COOP/COEP headers. **Transferable** ArrayBuffers move ownership. **Structured clone** copies data. We need decision-grade evidence.

## Mode

**prototype + benchmark**

## Required execution checklist

- You MUST read: `packages/o11ytsdb/PLAN.md` (M8), `src/types.ts`, `src/index.ts`, `src/column-store.ts`

- You MUST implement:
  1. **Message Protocol** (`src/worker-protocol.ts`): typed envelopes, request/response correlation
  2. **Worker Entry Point** (`src/worker.ts`): ColumnStore + codec in worker, handle ingest/query messages
  3. **Main-Thread Client** (`src/worker-client.ts`): async methods wrapping the worker
  4. **Transfer Strategy Benchmarks**: structured clone vs Transferable vs SharedArrayBuffer at 1K/10K/100K/1M samples

- You MUST measure: round-trip latency, main-thread blocking, memory overhead per strategy

- End with recommendation: `USE_TRANSFERABLE`, `USE_SHARED`, `USE_HYBRID`, or `USE_STRUCTURED_CLONE`

## Deliverable

- `packages/o11ytsdb/src/worker-protocol.ts`, `src/worker.ts`, `src/worker-client.ts`
- `packages/o11ytsdb/bench/worker-transfer.bench.ts`
- `packages/o11ytsdb/dev-docs/research/fanout-2026-04-15/05-worker-isolation-results.md`

## Constraints

- No external RPC libraries for the prototype
- Must work in modern browsers (Chrome 90+, Firefox 90+, Safari 15+)
- SharedArrayBuffer path must detect availability and fall back
- Worker prototype should also work with Node.js worker_threads for testing
