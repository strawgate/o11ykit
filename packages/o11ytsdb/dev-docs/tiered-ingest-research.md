# Tiered Ingest Research

## Summary

The current `TieredRowGroupStore(80 -> 640)` memory story is good, but ingest is still too expensive because every promoted hot window is synchronously decoded and re-encoded on the write path. Both the local compaction profile and the external systems research point to the same answer:

- keep writes on an append-only / immutable-promotion path
- make larger / denser cold layouts a later background concern

For `o11ytsdb`, the best next prototype is not a true in-place appendable `640` ALP chunk. It is a cold tier that can directly own sealed hot `80` row groups without decode+re-encode, then optionally repack those immutable units into `640` later.

## Local Findings

### Current compaction breakdown

Direct instrumentation of the current compacting round (`32` series, `80 -> 640`) showed approximately:

- total compacting round: `~2.59 ms`
- `cold.appendCompactedWindow`: `~0.90 ms`
- `codec.encodeBatchValuesWithStats`: `~0.66 ms`
- `codec.decodeBatchValuesView`: `~0.38 ms`
- `hot.peekCompactableLaneWindow`: `~0.26 ms`
- timestamp decode + encode: `~0.21 ms`

The main cost is the decode/re-encode model itself.

### Experiments already tried

The following changes were tested and either reverted or judged insufficient:

- batch-decode per hot row group during compaction
  - real win
  - compacting round improved from about `2.11 ms` to `1.81 ms`
  - one-shot ingest improved from about `66.1 ms` to `59.4 ms`
- only trigger compaction checks when a new hot chunk freezes
  - little to no material win
- decode the entire compacted window in one giant batch call
  - materially worse

### What this implies

The remaining ingest tax is not a small control-flow bug. It comes from:

1. decoding each promoted hot chunk
2. copying samples into a fresh cold slab
3. re-encoding the resulting `640`-sample cold chunk
4. re-encoding timestamps for the cold chunk

If we want a big ingest win, we need to stop doing one or more of those steps on the ingest path.

## Current Repo Seams

The current promotion seam is:

- [`TieredRowGroupStore.compactLane()`](../src/tiered-row-group-store.ts)
  - reads a [`RowGroupStoreLaneWindow`](../src/row-group-store.ts)
  - decodes each sealed hot `80` value blob
  - copies into `memberCount x 640` slabs
  - writes to [`RowGroupStore.appendCompactedWindow()`](../src/row-group-store.ts)
- the cold tier today is just another [`RowGroupStore`](../src/row-group-store.ts)
- reads depend on:
  - ascending `scanParts()` order from [`StorageBackend`](../src/types.ts)
  - `TimeRange` parts that may be stats-only or lazy-decoded
  - hot+cold merge in [`TieredRowGroupStore.scanParts()`](../src/tiered-row-group-store.ts)

That means the lowest-risk design changes are the ones that preserve:

- `StorageBackend.scanParts()` shape
- `TimeRange` semantics
- lazy decode of compressed chunk data

and change only how sealed hot windows become visible in cold storage.

## External Patterns

### Prometheus

Prometheus keeps current samples in an in-memory head plus WAL, flushes immutable blocks, and compacts those blocks later in the background.

Why it matters here:

- it keeps the write path cheap
- it tolerates a more fragmented recent tier
- it only pays merge/repack costs after data has left the hot write path

Sources:

- [Prometheus storage docs](https://prometheus.io/docs/prometheus/latest/storage/)
- [Prometheus storage and backfill docs](https://prometheus.io/docs/prometheus/3.3/storage/)

### InfluxDB TSM

InfluxDB uses a WAL + cache + immutable TSM files. Compaction is leveled and happens later, not on every write.

Why it matters here:

- immutable files are the unit of promotion
- background compaction is where denser layout wins are taken
- if compaction falls behind, writes stall, which is exactly the risk of synchronous `80 -> 640` repack

Sources:

- [InfluxDB TSM engine docs](https://docs.influxdata.com/influxdb/v1/concepts/storage_engine/)
- [InfluxDB v2 storage engine docs](https://docs.influxdata.com/influxdb/v2/reference/internals/storage-engine/)

### M3DB

M3DB buffers and compresses in memory over a configured block size, then flushes immutable compressed filesets. It explicitly documents the tradeoff between smaller blocks reducing active memory and larger blocks improving compression.

Why it matters here:

- this is the same `80` vs `640` tension we are seeing
- it reinforces that the hot compressed artifact should be a first-class unit
- it suggests a write-optimized representation and a later denser representation should be separate concerns

Sources:

- [M3DB storage engine docs](https://m3db.io/docs/architecture/m3db/engine/)
- [M3DB storage/fileset docs](https://m3db.io/docs/architecture/m3db/storage/)
- [M3DB commit log and snapshot docs](https://m3db.io/docs/architecture/m3db/commitlogs/)

### VictoriaMetrics

VictoriaMetrics emphasizes immutable parts and atomic registration: new parts either fully appear or do not appear, and merged parts either fully replace their sources or leave them untouched.

Why it matters here:

- atomic promotion is the right correctness bar
- immutable parts are a natural first cold representation
- queries over more parts are tolerated until background merges reduce fanout

Source:

- [VictoriaMetrics storage docs](https://docs.victoriametrics.com/victoriametrics/)

### Parquet and ORC

Parquet and ORC both use immutable append units and rely on page / row-group indexes and stats so readers can skip internal regions without reading the whole structure.

Why it matters here:

- a cold representation made of promoted `80` subparts can still be queryable if it carries enough per-subpart metadata
- we do not need immediate repack just to keep the query path viable

Sources:

- [Parquet page index](https://parquet.apache.org/docs/file-format/pageindex/)
- [ORC specification](https://orc.apache.org/specification/ORCv1/)

## What We Learned About "Appendable ALP"

There does not appear to be a standard "appendable ALP" design in the ALP literature or DuckDB materials.

The important constraint is structural:

- ALP is a bounded-frame/vector codec
- it chooses encoding parameters per frame
- frame-global properties such as exponent choice, FoR range, and exception layout make true in-place append awkward

In this repo, that is visible in the chunk-oriented [`ValuesCodec`](../src/types.ts), the batch encode/decode APIs in [`wasm-codecs.ts`](../src/wasm-codecs.ts), and the Rust ALP implementation’s frame-local metadata and exception layout.

The practical implication is:

- do not spend much time trying to make one ever-growing ALP blob appendable
- if we want an "appendable ALP-like" design, it should be page-based:
  - many sealed ALP mini-pages
  - plus a small open tail or later repack step

The known successful append-friendly floating-point codecs are streaming codecs such as:

- Gorilla / Beringei
- Chimp
- Elf / SElf

Those are better mental models for the hot write path than ALP itself.

Sources:

- [ALP paper](https://ir.cwi.nl/pub/33334/33334.pdf)
- [DuckDB ALP page](https://duckdb.org/library/alp/)
- [ALP source repo](https://github.com/cwida/ALP)
- [Gorilla paper](https://www.vldb.org/pvldb/vol8/p1816-teller.pdf)
- [Beringei post](https://engineering.fb.com/2017/02/03/core-infra/beringei-a-high-performance-time-series-storage-engine/)
- [Chimp paper](https://www.vldb.org/pvldb/vol15/p3058-liakos.pdf)
- [Elf paper](https://arxiv.org/abs/2306.16053)
- [SElf paper](https://arxiv.org/abs/2308.11915)

## Ranked Repo-Local Design Options

### 1. Direct promotion of sealed `80` parts into cold storage

This is the cleanest first prototype.

What changes:

- replace the current synchronous `80 -> 640` decode/re-encode path
- promote sealed hot `80` row groups directly into a cold-part index
- query across:
  - hot remainder
  - promoted `80` cold parts

Why it is first:

- lowest implementation risk
- preserves current `scanParts()` / `TimeRange` model
- strongest likely ingest improvement
- gives us a direct answer to the key question: does cheap immutable promotion fix the ingest tax enough to be worth the extra cold fanout?

Primary risk:

- cold query fanout can grow a lot if promoted `80` parts stay around too long

### 2. Containerized `8 x 80` cold block without value re-encode

This is the most balanced next design if plain promoted parts work but create too much cold-part overhead.

What changes:

- cold storage writes one logical container that holds up to `8` already-compressed `80` frames
- store:
  - frame directory
  - per-frame stats
  - frame offsets/sizes
  - maybe shared timestamp descriptors when cadence allows it
- queries still operate on subframes, not on a fake single `640` codec chunk

Why it is attractive:

- keeps ingest on a pure promotion path
- reduces top-level object/part fanout
- preserves the option of later true `640` repack

Primary risk:

- more storage code and metadata design than direct promoted parts

### 3. Two-step cold tier: promote now, repack later

This is probably the best medium-term architecture.

What changes:

- synchronous path uses either direct promoted parts or `8 x 80` containers
- background repack later produces a true denser `640` cold representation
- queries merge:
  - repacked cold
  - promoted cold
  - hot

Why it is attractive:

- cleanly separates write-path and long-term-storage goals
- matches the Prometheus / Influx / VictoriaMetrics pattern very closely

Primary risk:

- requires more state management and duplicate-avoidance bookkeeping

### 4. Logical `640` block made of compressed pages plus a tiny mutable tail

This is the most plausible "appendable ALP-like" direction.

What changes:

- treat a logical `640` block as:
  - many immutable compressed pages, e.g. `16` or `32` samples each
  - one open tail
- appends only touch the tail
- when the tail fills, encode one more page and append a new directory entry

Why it is attractive:

- closest thing to appendable compressed accumulation without raw `640` residency
- page-local stats and offsets make it queryable

Primary risk:

- higher format and query complexity
- this is a new storage format, not just a new promotion policy

### 5. Streaming hot codec plus ALP cold

This is a good broader research branch, but not the lowest-churn next prototype.

What changes:

- hot tier uses a streaming append-friendly codec
- sealed blocks later transcode into ALP or another denser cold representation

Why it is attractive:

- aligns well with known streaming floating-point codecs
- gives the ingest path the most natural compression model

Primary risk:

- more architectural churn than the direct-promotion variants
- can fight the row-group / shared-timestamp design if done naively

## Recommended Experiment Order

### Experiment 1: direct promoted `80` parts

Hypothesis:

- largest ingest win with acceptable query regression

Measure:

- append throughput
- post-ingest bytes/sample
- post-query resident bytes/sample
- hot-only query latency
- cold-only query latency
- boundary / mixed hot+cold query latency
- parts touched per query

### Experiment 2: `8 x 80` cold container without value re-encode

Hypothesis:

- retains most of Experiment 1’s ingest win while recovering storage/query overhead

Measure:

- same as Experiment 1
- metadata bytes/sample
- frames touched per query

### Experiment 3: background repack from promoted `80` to denser `640`

Hypothesis:

- promotion-first + background repack is the right long-term architecture

Measure:

- ingest throughput while repack is disabled
- repack throughput in isolation
- query behavior before and after repack
- correctness and duplicate-avoidance behavior during transition

### Experiment 4: page-based appendable compressed block

Hypothesis:

- a page-based logical `640` block can preserve much of the storage win without ever reserving raw `640` hot residency

Measure:

- append cost per sample
- bytes/sample at fill levels `80`, `320`, `640`
- pages touched per query
- encode/decode CPU

## Patterns To Adopt

### 1. Promote immutable units first

The synchronous ingest path should publish sealed immutable units, not rewrite them into a new form.

### 2. Keep publication atomic

The cold tier should follow the VictoriaMetrics rule:

- new cold data either appears fully or does not appear
- source hot data remains authoritative until publish succeeds

### 3. Keep repack off the ingest path

Dense `640` cold layout is still desirable, but it should be background work.

### 4. Use page / subpart metadata aggressively

If small immutable promoted units remain query-visible for a while, they need:

- time bounds
- offsets/sizes
- per-subpart stats

so queries can prune and fold efficiently.

## Pitfalls To Avoid

### Do not recompress on the synchronous ingest path

That is the current bottleneck.

### Do not force true in-place append into ALP frames

ALP appears to be frame-oriented, not naturally append-oriented.

### Do not assume the first cold representation must already be the densest one

That assumption is what created the current `80 -> 640` decode/re-encode tax.

### Do not let promoted-part fanout grow without a merge policy

If direct promoted `80`s are the first answer, they still need a later merge/repack story.

### Do not compromise atomicity

Any new cold representation still needs the same failure semantics we already added to the compaction path.

## Bottom Line

The strongest recommendation from local profiling, repo-local design review, and external systems research is:

1. **prototype direct promotion of sealed `80` row groups into cold storage without decode+re-encode**
2. **if query/storage overhead is too high, move to a containerized `8 x 80` cold block**
3. **treat true `640` repack as background work, not ingest work**
4. **only explore a page-based appendable compressed block after those lower-risk experiments**

If we want "appendable ALP," the realistic version is probably:

- **many sealed ALP mini-pages**
- **plus a small open tail**
- **not one ever-growing ALP frame**
