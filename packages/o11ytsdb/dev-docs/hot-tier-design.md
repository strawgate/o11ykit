# Hot Tier Design

## Goal

Improve the live ingest path without giving up the compaction wins of the
current row-group store.

The current design forces one number, `chunkSize`, to serve three different
roles:

- active mutable ingest window
- recently sealed storage unit
- long-lived compacted storage unit

That coupling is now the main reason large live chunk sizes look bad in
practice.

## Constraints

These come from the current benchmarks and are the non-negotiable inputs to
the design.

### Memory wins over query

Per [PLAN.md](/Users/billeaston/.codex/worktrees/9d53/o11ykit/packages/o11ytsdb/PLAN.md),
memory is the first priority. A hot-tier redesign that improves query time but
 materially increases bytes/sample is a miss.

### Larger live chunk sizes are dominated by hot-tier reservation

For `1,000,000` ingested samples using the current row-group design:

| chunk | bytes/sample | hot bytes | hot % |
|---:|---:|---:|---:|
| `640` | `0.4404` | `184,320` | `41.86%` |
| `1024` | `0.5737` | `294,912` | `51.41%` |
| `1280` | `0.6765` | `368,640` | `54.49%` |
| `1536` | `0.7840` | `442,368` | `56.43%` |
| `2048` | `1.0058` | `589,824` | `58.64%` |

So “just make the live chunk bigger” is the wrong direction.

### Tiny ingest units are expensive

With the current `RowGroupStore` at `chunkSize=640`, ingesting `1,000,000`
samples:

| append batch | ingest | ns/sample |
|---:|---:|---:|
| `1` | `57.5 ms` | `57.5` |
| `16` | `29.7 ms` | `29.7` |
| `64` | `19.4 ms` | `19.4` |
| `160` | `18.6 ms` | `18.6` |
| `640` | `15.5 ms` | `15.5` |

This means a hot tier cannot be “just tiny blocks everywhere.” Small units are
fine as a short-lived mutable staging mechanism, but they are not a good
steady-state sealed format.

### Candidate sealed-hot sizes

Sweep results against the current codec/query path suggest:

| sealed size | bytes/sample | step300 | step900 | step3840 |
|---:|---:|---:|---:|---:|
| `80` | `1.1698` | `15.615 ms` | `13.112 ms` | `10.730 ms` |
| `160` | `0.6695` | `12.846 ms` | `8.010 ms` | `5.468 ms` |
| `320` | `0.4486` | `17.561 ms` | `7.513 ms` | `2.548 ms` |
| `640` | `0.3936` | `14.880 ms` | `10.725 ms` | `1.297 ms` |

`80` is not attractive as a single-tier format, but it is attractive as a
bounded hot remainder because its reservation cost is small and it compacts
cleanly into `640` (`8 x 80 = 640`).

## Proposed Shape

Separate the three roles explicitly:

- `activeMutableSize`
- `sealedHotSize`
- `coldCompactedSize`

### Recommended initial ladder

- hot mutable + sealed hot: `80`
- cold compacted: `640`

Optional later rung:

- warm compacted: `320`

Initial implementation should skip `320` and prove `80 -> 640` first.

## Why This Is Not Arbitrary Tiering

The first implementation should stay deliberately narrow:

- exactly two tiers
- exactly one compaction rule: `8 x 80 -> 640`
- the same `RowGroupStore` representation on both sides

We should not start with an arbitrary tier graph or policy engine.

Why:

- it would introduce a lot more configuration surface before we know the
  right semantics
- it would make correctness and memory accounting harder to test
- it would blur whether the win came from tiering itself or from a more
  complex scheduler

If `80 -> 640` proves itself on ingest, memory, and query cost, then we can
generalize later. Until then, the backend should be explicit hot/cold tiering
with configurable sizes, not generic N-tier compaction.

## Current Implementation

The first backend implementation lives in
[tiered-row-group-store.ts](/Users/billeaston/.codex/worktrees/9d53/o11ykit/packages/o11ytsdb/src/tiered-row-group-store.ts).

It currently works by:

1. ingesting into a hot `RowGroupStore` configured for `80`
2. compacting whole sealed hot lane windows into a cold `RowGroupStore`
   configured for `640`
3. scanning cold parts first, then the hot remainder, so the query engine
   still sees one ordered stream

This keeps the API surface small while proving the memory thesis with a real
backend instead of only a benchmark prototype.

## Data Model

The hot tier stays row-group based. We do not introduce per-series microblocks.

### Per-lane state

```ts
type HotLane = {
  active: MutableRowGroupFrame;
  sealedHot: SealedRowGroupFrame[]; // size 80
  cold: ColdRowGroup[];             // size 640
};
```

### MutableRowGroupFrame

Append-friendly builder, sized for cheap ingest.

```ts
type MutableRowGroupFrame = {
  sampleCapacity: 80;
  hotTimestamps: BigInt64Array;
  hotCount: number;
  members: LaneMember[];
  memberValues: Float64Array[];
};
```

Properties:

- append-only
- shared timestamps, same as today
- minimal rewrite cost
- once full, sealed and replaced immediately

### SealedRowGroupFrame

Hot immutable row-group frame, target size `80`.

```ts
type SealedRowGroupFrame = {
  count: 80;
  tsChunk: TimestampChunk;
  valueBuffer: Uint8Array;
  offsets: Uint32Array;
  sizes: Uint32Array;
  packedStats: Float64Array;
  memberCount: number;
};
```

This should reuse the current frozen row-group representation as much as
possible.

### ColdRowGroup

Current long-lived compacted format, target size `640`.

This should remain the compaction target until a separate cold-format project
proves a better alternative.

## Merge Rules

### `80 -> 640`

Merge exactly `8` sealed-hot frames into one cold row group.

Same compatibility rules.

This is just another row-group merge, not a distinct encoding.

## Query Model

The query engine should continue to see one logical stream of parts.

### Scan order

For each series:

1. cold `640` row groups
2. sealed hot `80` frames
3. active mutable `80` frame

All yielded in timestamp order through the existing `scanParts` contract.

### Query expectation

- recent queries hit more `80` parts, but keep lower hot-memory cost
- long queries hit mostly `640`
- no new query API surface required

## Why This Is Better Than Raising Live `chunkSize`

Raising the live chunk size to `1024+` made memory worse because hot buffers
scaled with chunk size. This design keeps:

- bounded hot remainder
- small hot reservation
- large cold compacted unit

So we get larger effective storage blocks without paying their full hot-tier
reservation cost.

## What We Lose

- more compaction machinery
- more state transitions per lane
- more small-frame metadata before merge
- more moving parts in tests and benchmarks

The design is only worth it if:

- total memory during ingest improves materially
- final compacted bytes/sample stays close to current `640`
- ingest throughput does not regress badly

## Required Benchmarks

Any implementation must ship numbers for:

1. ingest throughput
   - current `640` single-tier
   - `80 -> 640`

2. memory over ingest progression
   - `50k`, `100k`, `250k`, `500k`, `750k`, `1M` samples

3. final bytes/sample at steady state

4. query latency
   - recent-window
   - mixed hot+cold window
   - full-range query

## Open Questions

1. Do we need the `320` rung?
   Current evidence says no for V1.

2. Should sealed `80` frames be compressed immediately, or kept raw until the
   `640` merge?
   V1 should probably keep them compressed and benchmark before adding another
   staging representation.

## V1 Recommendation

Build the smallest version that proves the idea:

- hot: `80`
- merge `8 x 80 -> 640`
- same query surface
- same row-group frozen format at `80` and `640`

If that does not clearly beat the current live-memory curve, stop there.
