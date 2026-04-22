# Worker Isolation Results (2026-04-15)

## Scope

This prototype implemented M8 worker isolation primitives for `o11ytsdb`:

- Typed request/response protocol with correlation IDs.
- Worker runtime that owns the storage backend + query engine. At the time of the
  experiment this was `ColumnStore`; the canonical backend is now `RowGroupStore`.
- Main-thread client wrapper for async ingest/query/stats RPC.
- Transfer strategy benchmark across 1K / 10K / 100K / 1M samples.

## Environment

- Date: **2026-04-15**
- Runtime: Node.js worker_threads (local dev container)
- Command: `node --expose-gc bench/dist/worker-transfer.bench.js`
- Iterations per sample-size/strategy: 12 (p50 reported)

## Protocol / runtime summary

- Envelope format:
  - Request: `{ id, kind: 'request', payload, meta }`
  - Response: `{ id, kind: 'response', payload, meta }`
- Correlation via monotonic numeric `id`.
- Supported worker RPCs:
  - `init`
  - `ingest`
  - `query`
  - `stats`
  - `echo` (transfer overhead benchmark primitive)
  - `close`
- Node + browser worker startup support is included (browser worker global or node `worker_threads.parentPort`).

## Measurements

### p50 round-trip latency (ms)

| Strategy | 1K | 10K | 100K | 1M |
|---|---:|---:|---:|---:|
| structured-clone | 0.429 | 2.369 | 12.545 | 116.902 |
| transferable | 0.431 | 0.430 | 0.607 | 0.705 |
| shared-array-buffer | 0.409 | 0.234 | 0.456 | 0.642 |

### p50 main-thread blocking proxy (ms)

(Using `setTimeout(0)` drift while the message operation is in-flight.)

| Strategy | 1K | 10K | 100K | 1M |
|---|---:|---:|---:|---:|
| structured-clone | 1.638 | 1.074 | 1.494 | 3.252 |
| transferable | 1.551 | 1.566 | 0.704 | 1.013 |
| shared-array-buffer | 1.509 | 1.439 | 1.407 | 0.817 |

### Memory delta per run (KB)

(Approximate `(heapUsed + arrayBuffers)` delta before/after benchmark loop, GC forced.)

| Strategy | 1K | 10K | 100K | 1M |
|---|---:|---:|---:|---:|
| structured-clone | -1.8 | 171.5 | 17,187.5 | 15,627.6 |
| transferable | 188.0 | 1,876.6 | 18,750.4 | 46,875.5 |
| shared-array-buffer | 189.7 | 1,875.4 | 18,750.4 | 187,500.4 |

## Interpretation

1. **Structured clone does not scale** for large payloads. At 1M samples it is two orders of magnitude slower than the other strategies (~117ms vs <1ms p50 RTT).
2. **Transferable and SAB both deliver near-flat RTT curves** up to 1M samples in this prototype.
3. **SAB memory remains resident by design** (shared backing stores are intentionally long-lived), so naive memory delta appears larger in this microbenchmark.
4. **Main-thread blocking proxy is similar** across strategies at small sizes; larger payloads favor transferable/SAB over structured clone.

## Recommendation

## **USE_HYBRID**

- Default to **`USE_TRANSFERABLE`** for broad compatibility and excellent low-overhead transfer characteristics.
- Enable **`USE_SHARED`** only when `SharedArrayBuffer` is available **and** deployment guarantees COOP/COEP isolation.
- Keep a **structured-clone fallback** for environments where neither transfer nor SAB path is possible.

In short: operationally this should ship as **`USE_HYBRID`** (`transferable` primary, `shared` optional fast-path).

## Follow-up notes

- Browser validation should be repeated in Chrome/Firefox/Safari with real `crossOriginIsolated` deployments for SAB.
- Add a second benchmark mode that uses ingest/query payloads directly (not only `echo`) to incorporate codec and store costs under each transfer mode.
