# M2 Drain prototype

The Drain template extractor is the M2 deliverable. A working prototype
exists; this doc covers what it is, where it lives, and what's left for
graduation into the shared codec workspace.

## What Drain does

Drain is a streaming log template extractor: given a sequence of log
lines, it groups lines whose token sequences are similar enough into
clusters, where each cluster's representative becomes a "template"
with `<*>` placeholders at the variable positions. Output per record
is `(template_id, vars[])`.

The algorithm is published; we ship a custom port because:

- The available Rust crate links a C regex library (`oniguruma`) that
  doesn't build for `wasm32-unknown-unknown` without a C sysroot. The
  C dependency is the masker — pre-tokenizer regexes that erase numeric
  and IP-address noise. Replacing it with a 200-LoC pure-Rust masker
  removes the build issue.
- The Python reference is the canonical source of truth in the
  literature. We cross-validate against it (ARI = 1.0 on five public
  Loghub corpora) so any future questions about correctness resolve to
  "do we still match the Python reference?".

## Status

| Property                  | Status                                                  |
|---------------------------|---------------------------------------------------------|
| TS port                   | Shipped at `../src/drain.ts` and integrated via         |
|                           | `DrainChunkPolicy`, `ColumnarDrainPolicy`,              |
|                           | `TypedColumnarDrainPolicy`                              |
| Rust port                 | Working at `../rust-prototype/drain/` (pre-graduation)  |
| Cross-validation          | TS ≡ Rust ≡ Python reference (ARI = 1.0 on 5 corpora)   |
| Native throughput (Rust)  | 0.9–3.3 M logs/s                                        |
| WASM size                 | 6.7 KB gz                                               |
| Masker (number / IP)      | Implemented pure-Rust; no `oniguruma`                   |
| Persistable state         | Not yet — M3 concern                                    |
| `LogParser` trait         | Not yet — M2 graduation                                 |

## Configuration

Default depth 4, similarity threshold 0.4, max children per node 100.
Tuned to match the Python reference's defaults so cross-validation
holds. Configurable via `DrainConfig`.

## Graduation work for M2

The prototype is at `../rust-prototype/drain/`. M2 ships when:

1. The crate moves to `packages/o11y-codec-rt/drain/` in the shared
   codec workspace.
2. A `LogParser` trait wraps Drain so future template extractors can
   slot in without touching the engine.
3. Persistable state lands: snapshot/restore for the per-stream Drain
   tree so chunk-close → chunk-open round-trips don't lose template
   IDs.
4. The masker layer becomes pluggable from the host (TS or Rust),
   matching how `BodyClassifier` plugs in at the engine level.

The graduation does not need new validation runs — the cross-validation
protocol is already in place via TS ↔ Rust bit-identical cluster
sequences.

## Why one port per language

Both implementations exist for the dual-implementation protocol the
o11ykit family follows: TypeScript and Rust→WASM, mutual oracles,
cross-validated on every PR. The Rust port is the fast path; the TS
port is the always-available fallback for the read query path
(decoded chunks need Drain to reconstruct templated bodies even when
the WASM module isn't loaded).
