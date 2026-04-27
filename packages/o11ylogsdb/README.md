# o11ylogsdb

Browser-native (also Node, Bun, Edge) logs database for OpenTelemetry
data. Sister to `o11ytsdb` (metrics).

**Status:** scaffolding. Architecture validated against benchmarks
under `bench/`. See [PLAN.md](./PLAN.md) for milestones,
[`dev-docs/`](./dev-docs/) for the design rationale.

## Goal

20× storage efficiency vs raw OTLP/JSON, ~17 B/log on a structured-
JSON-heavy mix and ~12 B/log on a templated-text-heavy mix. WASM-
accelerated codec stack (Drain template extraction + FSST + ALP /
Delta-ALP + Roaring-lite + binary fuse filters). Streaming query
executor that never materializes proportional-to-N.

## Status (per milestone)

| Milestone | Status |
|---|---|
| **M0 — Codec workspace migration** | **complete.** `core` (bit I/O, ms→ns, zigzag), `xor-delta` (Gorilla), `alp` (full ALP/Delta-ALP), `interner` (FNV-1a string interner), `drain` (M2 below). All extracted to `packages/o11y-codec-rt/`. |
| **M1 — FSST + binary fuse + Roaring-lite** | **FSST first cut shipped** at `packages/o11y-codec-rt/fsst/` — greedy encode, sequential decode, naive frequency-based table builder; round-trips verified. Suffix-counting selection, hash-accelerated encode, branch-free SIMD decode are follow-up. Binary fuse 8/16 + Roaring-lite pending. |
| **M2 — Drain template extractor** | **graduated** to `packages/o11y-codec-rt/drain/`. ARI = 1.0 vs the published Python reference on five public log corpora. TS port at `src/drain.ts` is bit-identical and integrated via `DrainChunkPolicy`, `ColumnarDrainPolicy`, `TypedColumnarDrainPolicy`. Configurable masker + persistable state pending — see [`dev-docs/drain-prototype.md`](./dev-docs/drain-prototype.md). |
| **M3 — Per-stream chunk format** | **scaffolded** (`src/chunk.ts` v1 wire format, `src/stream.ts` registry, `ChunkPolicy` plug-in surface with preEncode/postDecode + codecMeta round-trip). Per-column refinement pending. |
| **M4 — Per-column codec dispatch** | **first cut shipped** (`ColumnarDrainPolicy`, `ColumnarRawPolicy`, `TypedColumnarDrainPolicy`). Per-column codec specialization (ALP for ints, FSST for strings, BF16 for identifiers) pending. |
| M5 — OTLP logs ingest pipeline | not started |
| M6 — Indexes | severity zone-map shipped; BF8 / BF16 / Roaring-lite pending |
| **M7 — Streaming query executor** | **first cut shipped** (`src/query.ts` streaming executor with chunk-level pruning by zone-map and severity range; `src/compact.ts` re-encodes chunks to a different policy). Builder API + cache pending. |
| M8 — Worker isolation + public API | not started |

End-to-end engine round-trip works: see `bench/engine-roundtrip.bench.ts`
(default policy), `bench/engine-drain.bench.ts` (Drain templating),
`bench/engine-columnar.bench.ts` (M4 thesis), and
`bench/engine-typed.bench.ts` (M4 typed slots). Chunk serialization
round-trips; first-32-record content check passes on every corpus.

## Reading order

- [PLAN.md](./PLAN.md) — milestones, gates, architectural decisions.
- [`dev-docs/findings.md`](./dev-docs/findings.md) — what we measured.
- [`dev-docs/techniques.md`](./dev-docs/techniques.md) — what we ship and why.
- [`dev-docs/drain-prototype.md`](./dev-docs/drain-prototype.md) — M2 Rust port.
- [`bench/README.md`](./bench/README.md) — bench harness, corpora, modules.
