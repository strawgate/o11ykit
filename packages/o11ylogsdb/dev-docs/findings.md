# Findings

What we measured. Each row is one experiment; each one corresponds to a
bench module under `../bench/` that can be re-run from the repo root with
`npm run bench --workspace o11ylogsdb -- <module>`.

The benchmark corpora are the public Loghub-2k samples (HDFS, Apache,
BGL, Linux, OpenStack, OpenSSH) plus a synthetic structured-JSON corpus
shaped like a typical Node HTTP-logger record (timestamp, level, msg,
req object with method/url/headers/userId, res object with status, plus
a per-row request UUID).

## Per-corpus baselines

Drain template extraction layered on ZSTD-19 over the NDJSON form, on
the Loghub-2k samples. These are the floors we must match or beat with
the typed-column stack:

| Corpus    | B/log | ratio vs raw OTLP/JSON |
|-----------|------:|------------------------:|
| Apache    |  3.12 |                  63.20× |
| Linux     |  4.44 |                  44.39× |
| BGL       |  6.64 |                  35.49× |
| HDFS      |  7.72 |                  31.62× |
| OpenStack | 18.67 |                  21.74× |

All five clear the 20× target with only Drain + ZSTD-19. The typed
columnar stack must not regress these numbers and aims to recover
information-theoretic headroom on the corpora that have it (Apache,
Linux).

## Validated

- **20× target is reachable.** Drain + ZSTD-19 alone hits 21–63× on the
  five public Loghub corpora.
- **Build a custom binary format, don't adopt an existing columnar
  archive format.** The off-the-shelf candidates either bundle the
  right primitives in a server-tier crate that won't build for
  `wasm32-unknown-unknown` (tens of thousands of LoC, native deps), or
  rely on archive-level dictionaries that don't fit a streaming-decode
  browser store.
- **WASM throughput is comfortable.** A pure-Rust FSST decoder
  measures 4.93 GB/s in the WASM sandbox, 5× over the ~1 GB/s target.
  Per-engine binary budget revised from <10 KB gz to <25 KB gz to
  cover the combined codec stack; current measured artifact is 21 KB gz.
- **In-house Drain port is bit-identical to the published Python
  reference** (ARI = 1.0000 on five Loghub corpora). 6.7 KB gz, 0.9–3.3
  M logs/s native. Ready to graduate as M2.
- **TS Drain matches the Rust port bit-for-bit** across all six
  Loghub-2k corpora (zero mismatches in 12 000 records). Mutual-oracle
  requirement satisfied: TS = Rust = published reference.
- **Layout > Drain.** A binary columnar form (length-prefixed numeric
  columns, per-chunk template dict moved *inside* the compressed
  payload) beats NDJSON+ZSTD-19 on 6/6 Loghub-2k corpora *before*
  Drain is applied. Drain on top adds another 1.0–1.19×. Apache lands
  at 3.83 B/log = 1.52× over the NDJSON+ZSTD-19 baseline.
- **Per-template variable typing is the highest-leverage M4 lever.**
  On corpora dominated by 1–2 high-cardinality variable slots
  (random block IDs, request UUIDs, embedded microsecond timestamps),
  per-slot codec dispatch — int64-LE for random 60-bit ints, ZigZag
  delta-varint for sequential ints, raw-bytes-after-prefix for UUIDs,
  delta-of-micros for embedded timestamps — recovers 17–35% over
  length-prefixed UTF-8 + ZSTD-19. HDFS goes 22.5 → ~19 B/log;
  Apache typed_z3 ingest goes 9.6 → 4.0 ms (-58%).
- **ZSTD level matters on body bytes; structural columns are free at
  any level.** Body @ z3 vs body @ z19 = +26% storage on average.
  Structural columns (timestamps, severities, attribute keys) cost the
  same at z3 and z19. Hot ingest writes body @ z3 (50× faster encode);
  background compaction promotes body to z19. Structural columns
  hard-coded at z19 — no config knob.
- **Per-column ZSTD streams give a small consistent win.** Independent
  ZSTD per column beats single ZSTD over concatenated columns by
  1.2–4.0% (0.11–0.49 B/log) on 6/6 Loghub corpora. Frame overhead
  (~30 B per column) is smaller than the per-column entropy
  specialization gain at chunk sizes ≥ 5 KB. M4 polish item.
- **Severity zone-map prunes correctly when used as a header check.**
  Computed at chunk-close from observed records; query side reads only
  the header to skip chunks whose `severityRange.max < severityGte`.
  Auditable via `chunksPruned` stat in `QueryStats`.

## Refuted

- **Trained ZSTD dictionaries.** A 16 KB-trained ZSTD-19 dictionary
  ties or *loses* on 5/5 text corpora and 3/4 string corpora at our
  chunk granularity. The often-cited 10–30% literature gain assumes
  archive-scale corpora; it doesn't hold for 1024-row chunks. Removed
  entirely.
- **Cross-chunk shared ZSTD dictionary as a hot-path technique.** Does
  recover 77–100% of the single-corpus advantage but yields only
  0.13–1.01 B/log on top of per-chunk ZSTD-19, at the cost of a
  cross-chunk decode dependency. Kept on the background-compaction
  shortlist; not adopted for hot ingest.
- **Per-stream Drain isolation as materially different from shared
  Drain.** Sharing one Drain across six Loghub streams costs 0.11%
  (259 B / 237 KB total), template counts identical. Engine ships
  with shared-by-default; per-stream available via `policyFactory`
  for isolation when callers want it.
- **Naive Drain integration over NDJSON.** NDJSON envelope tax plus an
  uncompressed chunk-header template dict makes Drain-templated NDJSON
  *5–35% worse* than plain NDJSON+ZSTD-19 on every Loghub-2k corpus.
  Drain in NDJSON form is a structure primitive, not a compression
  primitive. The columnar binary form is required.
- **Hierarchical Drain on KVList sub-fields.** Running Drain on
  `msg`, `req.url`, etc. inside a structured-JSON body saves only
  0.64 B/log aggregate on a typical Node-logger corpus, while making
  high-cardinality columns *worse*: per-row UUID columns get +5.05
  B/log when accidentally Drain-templated. ZSTD already captures most
  implicit templating. Apply Drain only to top-level string-typed
  bodies; the M4 classifier must skip high-cardinality fields by
  default.
- **Per-chunk n-gram body Bloom.** Trigram Bloom averages 2.59 B/log
  (15% of total chunk budget). Binary fuse is *worse* at chunk scale
  (12.7 vs 10 bits/key — the published 9-bits/key figure needs
  N ≥ 100 K, not the 1.5 K–7 K trigrams a single chunk produces).
  Token-only filtering hits 32% recall on arbitrary substrings.
  Substring queries fall back to template-ID prune + decompress-and-
  scan on surviving chunks.
- **Per-chunk per-token Roaring postings.** Trigram postings cost
  292 B/log (the index is larger than the source corpus). Token
  postings cost 75 B/log with 19% recall. The "1–2 B/log per-token
  postings" claim from production systems applies at *stream scope*
  (aggregating across thousands of chunks), not at our 1–2 K-row
  chunk scope where per-bucket header overhead and dense row vectors
  dominate. M7 candidate when chunk lists span many chunks.
- **Lossy compaction.** Numeric-ID masking + IP normalization recovers
  HDFS to 6.65 B/log and BGL to 12.3, but Apache/Linux/OpenSSH gain
  only 4–8% and OpenStack goes net-negative because UUIDs evade
  digit-run regexes. The engine preserves bytes; the principled answer
  to "I want the signal without the bytes" is logs-to-metrics
  derivation at a separate product layer (template + counts + duration
  histograms become a metric stream).

## Lossless ceilings per corpus

Information-theoretic floors imposed by per-template variable
distributions:

| Corpus    | Floor (B/log) | Bottleneck                                                |
|-----------|--------------:|-----------------------------------------------------------|
| Apache    |          ~3   | None dominant; balanced template payload                  |
| Linux     |          ~5   | None dominant                                             |
| OpenSSH   |          ~5   | None dominant                                             |
| BGL       |         ~12   | Embedded microsecond timestamps (one slot, 5.53 B/log)    |
| HDFS      |         ~12   | 5 templates × ~10 B/log random 60-bit block-ID columns    |
| OpenStack |         ~14   | One template's request-UUID slot alone is 19.17 B/log     |
| Synth-JSON|         ~14   | Per-row request UUID (high-cardinality identifier column) |

These are the lossless lower bounds. Reaching them requires
high-cardinality identifier columns to be routed to the same raw-bytes-
plus-binary-fuse-filter path used for trace IDs (skip ZSTD entirely on
those columns — ZSTD can't compress random bytes).

## Body-shape distribution (real OTLP traffic)

Sampled from production OTLP-logs traffic:

| Body kind                  | Share |
|----------------------------|------:|
| Templated string           | ~61%  |
| KVList (structured-JSON)   | ~39%  |
| Free-text                  |  <1%  |

The prior assumption was 80–95% templated / 10–25% KVList / 5–15%
free-text. Revised: KVList recursive flatten is a first-class M4 path,
not a follow-up. Free-text codec budget can be tightened.

## Engine round-trip benchmarks

Numbers below are from `../bench/` modules, executed on the development
machine. Use them as a regression baseline, not as published targets.

- OpenStack full-decode query: 1860 → 765 ms (-59%) after the M4 typed
  decode hot-path optimizations.
- Apache typed_z3 ingest: 9.6 → 4.0 ms per chunk (-58%) after the
  per-template Int8Array transpose, growable single-buffer ByteBuf,
  and BYTE\_TO\_HEX\[256\] table replacements.
- Sustained-ingest profile at 500 K records: GC pauses < 100 ms with
  the WeakMap reference-identity fast path on `StreamRegistry`.

## Per-package vs cross-engine

These findings are specific to log records (templated text bodies,
high-cardinality identifier sub-fields, per-(resource, scope) stream
grouping). The metric engine (`o11ytsdb`) and the future trace engine
inherit codec primitives from the shared codec workspace but make
their own layout decisions; nothing here generalizes verbatim.
