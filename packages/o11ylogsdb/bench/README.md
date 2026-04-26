# o11ylogsdb bench

Bytes-per-log benchmarks against the public Loghub-2k samples. The
`bytes-per-log` benchmark is the merge gate: any change that regresses
bytes/log >1% on any corpus blocks merge (per
[../PLAN.md](../PLAN.md)).

## Quick start

```bash
# 1. Fetch Loghub-2k samples (~1 MB total, committed for reproducibility)
bash bench/scripts/download-loghub.sh

# 2. Compile the bench
npm run bench:build --workspace o11ylogsdb

# 3. Run
npm run bench --workspace o11ylogsdb
# or with markdown output:
node bench/run.mjs --markdown
```

Results land in `bench/results/{module}-{timestamp}.json`.

## Modules

| Module                    | Measures                                                                       |
|---------------------------|--------------------------------------------------------------------------------|
| `bytes-per-log`           | Each Loghub-2k corpus through every baseline codec (Node built-ins).           |
| `pino-roundtrip`          | Synthetic structured-JSON corpus (HTTP-logger shape) through KVList policies.  |
| `engine-columnar`         | M4 thesis: columnar binary payload vs NDJSON+ZSTD on the templated path.       |
| `engine-typed`            | M4 per-template typed-slot dispatch vs columnar baseline.                      |
| `per-stream-drain`        | Cost of sharing one Drain across streams vs per-stream isolation.              |
| `hierarchical-drain`      | Drain on KVList sub-fields (refuted; see findings).                            |
| `cross-chunk-dict`        | Per-stream ZSTD dictionary built from chunk 0's bytes.                         |
| `lossy-archive`           | Cold-tier compression floor under destructive normalizations (out of scope).   |
| `ngram-bloom`             | Per-chunk substring-search filters: Bloom (n=3, n=4), binary fuse, tokens.    |
| `token-postings`          | Per-token Roaring postings at chunk scope.                                     |
| `per-column-zstd`         | Independent ZSTD per column vs single ZSTD over concatenated columns.          |
| `zstd-level-asymmetry`    | Per-column ZSTD level: body bytes vs structural columns.                       |
| `query-latency`           | Streaming query executor: time-range, severity, body-substring, KVList leaf.   |
| `query-at-scale`          | Query latency at 100 K and 1 M record scales.                                  |
| `multi-stream`            | 100 streams × 500 K records: chunk-list ordering and pruning behavior.         |
| `sustained-ingest`        | M5 ingest gate: GC pauses + memory delta over 500 K records.                   |
| `append-latency`          | Per-record `append()` latency distribution.                                    |
| `drain-churn`             | Drain template-tree growth under adversarial input.                            |
| `compaction`              | `compactChunk()` re-encode latency and ratio.                                  |
| `byte-decomposition`      | Per-(template, slot) byte cost — diagnostic for typed-column work.             |
| `profile-policies`        | CPU profile of every shipped policy.                                           |

Each module's headline finding is summarized in
[`../dev-docs/findings.md`](../dev-docs/findings.md).

## Round-trip verification

Every codec/policy bench verifies content correctness on the first 32
records of each chunk under the same Drain whitespace rule
(multi-space → single space). The exception is `lossy-archive`, whose
transforms are intentionally destructive — round-trip is not checked
and the experiment is informational only.

## Corpora

- `bench/corpora/loghub-2k/` — 2 K-line samples checked in
  (~1 MB total). The public Loghub-2k samples are the canonical
  academic samples with golden ground-truth template labels.
- `bench/corpora/loghub-full/` — full corpora (gitignored). Fetch
  manually for compression-ratio measurements at 100 K-line scale.
- `bench/corpora/synthetic/` — generated structured-JSON corpus
  shaped like a typical Node HTTP-logger record (timestamp, level,
  msg, req object with method/url/headers/userId, res with status,
  per-row UUID). Generate with
  `python3 bench/scripts/generate-pino-corpus.py` (deterministic;
  fixed seed; output committed).

## Reference baseline

Drain + ZSTD-19 over the NDJSON form, on full Loghub corpora:

| Corpus    | B/log | ratio vs raw OTLP/JSON |
|-----------|------:|------------------------:|
| Apache    |  3.12 |                  63.20× |
| Linux     |  4.44 |                  44.39× |
| BGL       |  6.64 |                  35.49× |
| HDFS      |  7.72 |                  31.62× |
| OpenStack | 18.67 |                  21.74× |

The 2K-sample numbers diverge somewhat from the full-corpus numbers;
fetch full corpora when you want the table to reproduce. Apple Silicon,
Node 22+, ZSTD via `node:zlib`.
