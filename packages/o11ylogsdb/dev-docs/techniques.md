# Techniques

What we ship. The "why" for each is in [`findings.md`](./findings.md);
this doc is the catalog.

## Storage layout

**Per-stream chunking.** A stream is the (resource, scope) tuple. Each
stream owns an ordered chunk list; each chunk holds 1024 records by
default with a 5-minute time cap. Resource attributes are hoisted to
the chunk header — a query like `service.name = "X"` becomes a header
check, never a row scan.

**Binary columnar payload.** A chunk's body is a length-prefixed
sequence of column buffers (timestamps, severities, body bytes,
attribute keys, etc.). Per-chunk codec metadata — template
dictionaries, per-slot type tables — lives *inside* the compressed
payload, not in the uncompressed JSON header. Putting it in the header
costs ~0.5 B/log of overhead at our chunk size.

**Per-column ZSTD streams.** Each column is compressed independently.
Frame overhead is ~30 B per column; the per-column entropy
specialization gain dominates that at chunk sizes ≥ 5 KB (1.2–4.0%
storage win).

**ZSTD level by column.** Body bytes are the only column whose ZSTD
level matters. Hot ingest writes the body column at z3 (50× faster
encode); background compaction promotes it to z19 for the full ratio.
Structural columns (timestamps, severities, attribute keys, dictionary
payloads) are hard-coded at z19; no config knob.

## Body codec dispatch

The body classifier picks one of:

- **Templated.** Body is a string parseable by Drain. Replace with
  `(template_id, vars[])`. Per-chunk template dictionary in the
  compressed payload. The variable-position values become per-template
  slot columns.
- **KVList.** Body is a recursive object/map. Recursively flatten to
  per-key columns; the same machinery drives `attributes`. ~39% of
  real traffic; first-class path.
- **Free-text.** Body is a string Drain rejects. FSST + ZSTD-3.
  <1% of real traffic; budget is small.
- **Bytes / primitive.** Pass through.

## Per-(template, slot) typed columns

After Drain runs, each templated chunk has a template dictionary plus,
per template, a list of variable-position values. Each (template, slot)
pair is examined and may be routed to a typed encoder:

| Slot type        | Detector                                            | Encoding                                            |
|------------------|-----------------------------------------------------|-----------------------------------------------------|
| `STRING`         | Default                                             | Length-prefixed UTF-8                               |
| `SIGNED_INT`     | `^(0\|-?[1-9]\d*)$`, no leading zeros               | ZigZag varint, no prefix                            |
| `UUID`           | Canonical 8-4-4-4-12 hex                            | 16 raw bytes                                        |
| `UUID_NODASH`    | 32 lowercase hex chars                              | 16 raw bytes                                        |
| `PREFIXED_INT64` | All values share a literal prefix; suffix is int    | Prefix once in meta + 8-byte LE i64 per row         |
| `PREFIXED_UUID`  | Shared prefix; suffix is UUID                       | Prefix once in meta + 16 raw bytes per row          |
| `TIMESTAMP_DELTA`| Values match a known timestamp shape                | Format selector + ZigZag delta-of-prior in micros   |

All detectors are *generic* — they recognize byte shapes, never specific
literals. The longest common prefix across a slot's values is found by
linear scan; if it matches a known shape, the residual is encoded with
the shape's typed encoder. The engine never assumes the log format.

Slots with fewer than 50 records, or with mixed value shapes within a
slot, fall back to length-prefixed UTF-8. The dispatch overhead is one
byte per row, which ZSTD-19 collapses to nothing.

## Drain template extractor

Streaming log parser. Fixed-depth tree, similarity-threshold matching.
Default depth 4, similarity threshold 0.4, max children per node 100.
The TS reference port at `../src/drain.ts` is bit-identical to the Rust
port at `../rust-prototype/drain/` (when graduated; see
[`drain-prototype.md`](./drain-prototype.md)), and both produce
ARI = 1.0 against the published Python reference.

The Rust port replaces the upstream Rust crate's regex masker with an
in-house masker: the upstream crate links a C library (`oniguruma`)
that doesn't build for `wasm32-unknown-unknown` without a C sysroot.
Our masker is a 200-LoC port and builds to 6.7 KB gz.

A `policyFactory(streamId, resource, scope) → ChunkPolicy` hook on
`LogStore` lets callers give each stream its own Drain instance; the
shared-by-default Drain costs only 0.11% over per-stream isolation, so
isolation is a power-user knob.

## Indexes

**Severity zone-map.** `{min, max}` pair in the chunk header. Computed
at chunk close from observed records. Query side reads only the header
to skip chunks whose `severityRange.max < severityGte`.

**Time-range zone-map.** `{minNano, maxNano}` in the chunk header. The
default chunking policy assumes records are appended in chronological
order (the OTLP-batch invariant); revisit if/when a reorder buffer
lands.

**Resource attributes.** Hoisted to the chunk header. `service.name = X`
is a header check, no payload decode.

**Body trigram filters: not shipped at chunk scope.** A 1024-row chunk
produces 1.5 K–7 K trigrams; the published "9 bits/key" figure for
binary fuse filters needs N ≥ 100 K to amortize the per-filter
constant. At chunk scope, both Bloom and Roaring postings cost more
B/log than they save. Substring queries fall back to template-ID prune
+ decompress-and-scan.

**Stream-scope postings: M7 candidate.** The above changes when
indexing across thousands of chunks (a stream's full chunk list, not a
single chunk). Per-token Roaring postings keyed by `hash(token) % 64K`,
aggregated at stream scope, become viable. Queue this for the M7 query
engine once chunk lists span many chunks.

**Trace ID lookup.** Per-chunk dictionary plus a binary fuse 16 filter
on trace IDs. UUID-shape attribute and body sub-fields use the same
raw-bytes-plus-BF16 path: those values can't compress under ZSTD
(random bytes are random bytes), and the BF16 lookup is the right
data structure for "does this chunk contain this ID?".

## Patterns adopted from production logs systems

The deep dive on production OSS log databases surfaced five patterns
that fit our constraints (browser-native, lossless, <25 KB gz WASM).
None require copying code; they're architecture choices.

1. **Stable chunk-list ordering by `(stream_fingerprint, ts_bucket_start)`.**
   With a chunk-level zone map on the resource fingerprint, a query
   that filters on resource attributes prunes most of the chunk list
   without decode. Lands in M3 (chunk format) + M7 (query planner).
2. **Bloom over structured-metadata `key=value`, not body trigrams.**
   At ingest time, hash known structured fields into a per-chunk
   Bloom; the body itself stays unindexed. Confirms our M6 plan.
3. **Native typed sub-columns beat `Map(String, String)` shapes.**
   Per-attribute-key columnar storage is 9× faster for path-style
   queries than a serialized string-map. Vindicates lazy column
   materialization.
4. **Result cache at `(query_hash, chunk_id)` granularity.**
   Chunks are immutable in our model; cache invalidation is trivial
   (entries die when the chunk is evicted). M7 query-engine
   deliverable.
5. **Per-token Roaring postings at stream scope.** See "Indexes"
   above. The `hash(token) % 64K` keying lets the index size stay
   bounded; AND-ing a token-postings bitmap with a severity-postings
   bitmap answers `body contains "x" AND severity ≥ WARN` without
   decoding either column. M7 candidate.

## Round-trip semantics

The Drain pipeline normalizes runs of whitespace to single spaces. Body
substring queries match against the *normalized* form. Round-trip
preserves bytes for everything else (numeric values, attribute values,
resource attributes, trace/span IDs, timestamps).

## What we don't build

- **Persistence.** In-memory only. `serialize()` / `deserialize()` on
  chunks for the caller to use IndexedDB if they want.
- **Multi-tenancy, auth, clustering.** Single user, single tab.
- **String-DSL query parser.** A typed builder is sufficient for v1.
  ~800 LoC of parser deferred to v1.1.
- **Lossy compression.** The engine preserves bytes. Logs-to-metrics
  derivation at a separate product layer is the principled answer to
  high-volume identical-log workloads.
- **Adaptive chunk sizing.** 1024 rows + 5-min cap is fine.
