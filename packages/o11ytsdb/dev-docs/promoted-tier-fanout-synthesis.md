# Promoted Tier Fan-Out Synthesis

## Goal

Find the best next experiment for the `hot -> promoted 80 -> compacted 640`
design after PR `#167`.

The key measured problem on the current experimental path is that append is
still too expensive even after moving `80 -> 640` compaction off the write
path. That points to the remaining bottleneck being promotion into the
transient `80` tier rather than query-side mixed chunk handling.

## Main conclusion

The next prototype should focus on making **promotion nearly O(1)** by
replacing the current `PromotedPartStore` indexing shape.

The strongest recommendation from the fan-out is:

1. Treat promoted `80`s as first-class immutable parts.
2. Store them in an **append-only per-lane page log**.
3. Keep only a **small per-series list of lane memberships**.
4. Let query scan a lane's time-ordered promoted pages directly.
5. Let background compaction advance a per-lane `head` cursor instead of
   rebuilding global per-series indexes.

This preserves the current architectural direction:

- storage owns the chunk ladder
- query stays generic over chunk sizes
- future chunk sizes can be added without new tier-specific query logic

## Why this won

The current promoted-store cost is mostly structural:

- `promoteWindow()` inserts a `PromotedPartRef` into `seriesParts[id]` for
  every promoted member
- insertion uses backward scan + `splice()`
- `commitCompactedLaneWindows()` rebuilds the whole `seriesParts` structure

That means the promoted tier currently does work proportional to historical
promoted state rather than the newly published `80`.

The fan-out converged on the idea that this is the wrong cost model.

## Best next prototype

### Primary recommendation

Prototype an **append-only promoted lane log**:

- one promoted lane log per `(groupId, laneId)`
- each promoted `80` becomes one appended page in that lane
- each series keeps only lane memberships and member index within the lane
- `scanParts(id, ...)`:
  - visits that series's participating lanes
  - binary-searches the lane's promoted pages by time
  - emits matching parts in order
- background compaction:
  - reads contiguous lane pages
  - compacts `8 x 80 -> 640`
  - advances a lane `head` pointer on success

### Smaller-scope fallback

If the full lane-log rewrite feels too large for the next slice, the smaller
variant is:

- keep `seriesParts[id]`
- make it append-only
- stop ordered `splice()` insertion
- stop full `rebuildSeriesParts()` after every compaction
- mark dead promoted refs and clean them up in batches

This is likely the minimum-diff stepping stone if we want an intermediate PR.

## Background compaction guidance

The scheduling fan-out said not to build a job system yet.

Recommended minimal model:

- promoted parts are fully queryable until compacted
- background queue is deduped by `(groupId, laneId)`
- compacted windows are committed atomically
- failed lanes stay queryable in promoted form
- track backlog and failure counters so we can see if the system is falling
  behind

Useful counters:

- pending compaction lanes
- promoted window count
- compactable window count
- promoted bytes
- append-path compaction time
- background compaction time
- failure count / quarantined lane count

## External pattern alignment

The external TSDB research converged on the same high-level design:

- cheap immutable-part publication first
- denser merge later in the background

Most relevant patterns:

- Prometheus: mutable head, immutable blocks, later compaction
- VictoriaMetrics: immutable parts published atomically, background merges
- Influx TSM: cheaper lower-level materialization, heavier higher-level
  recompression later
- M3DB: append-friendly compressed buffering that later flushes into immutable
  compressed structures

The important takeaway is not to make the write path manufacture final cold
layout immediately.

## Recommended execution order

1. Land PR `#167`.
2. Prototype append-only promoted lane logs.
3. Re-run maintained benchmarks:
   - `bench:tiered-store-matrix`
   - `bench:tiered-cardinality-sweep`
4. Compare against the fallback variant:
   - append-only per-series refs + batched cleanup
5. Only revisit the `640` frozen format if promotion is no longer the main
   append-path cost.

## Prototype result

The append-only promoted lane-log prototype is the right next direction.

Current maintained measurements on the prototype:

- `bench:tiered-store-matrix -- 1 1 64`
  - current `640` ingest: `16.715 ms`
  - tiered `80 -> 640` append-path ingest: `55.41 ms`
  - tiered background compaction: `21.699 ms`
  - tiered end-to-end ingest: `77.109 ms`
  - post-ingest memory:
    - current `640`: `0.4404 B/sample`
    - tiered `80 -> 640`: `0.3014 B/sample`
- `tiered-cardinality-sweep`
  - exact `640`-fill cases hit parity on memory
  - low-fill and high-cardinality cases still show the large tiered-memory win

So this prototype does **not** solve ingest, but it does move promotion much
closer to viable without changing the clean mixed-size query model.

## Non-goals for the next step

Do not prioritize:

- more query-engine specialization
- adding `2048` storage tiers yet
- containerized promoted storage for its own sake
- a brand-new frozen format before promotion is fixed

The highest-value next question is still:

**How do we make publishing promoted `80`s cheap enough that the tiered design
is viable at ingest time?**
