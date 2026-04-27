# M2 Drain — graduated

The Drain template extractor lives at
[`packages/o11y-codec-rt/drain/`](../../o11y-codec-rt/drain/) as a
shared workspace crate. Pure Rust, `#![no_std]` with `extern crate
alloc`, no FFI dependencies. Each consuming engine supplies its own
`extern "C"` wrappers.

## What Drain does

Drain is a streaming log template extractor: given a sequence of log
lines, it groups lines whose token sequences are similar enough into
clusters, where each cluster's representative becomes a "template"
with `<*>` placeholders at the variable positions. Output per record
is `(template_id, vars[])`.

The algorithm is published; we ship a custom port because:

- The available Rust crate of the algorithm links a C regex library
  that doesn't build for `wasm32-unknown-unknown` without a C sysroot.
  The C dependency is the masker (pre-tokenizer regexes that erase
  numeric and IP-address noise). Replacing it with a 200-LoC pure-Rust
  masker removes the build issue.
- The Python reference is the canonical source of truth in the
  literature. We cross-validate against it (ARI = 1.0 on five public
  log corpora) so any future questions about correctness resolve to
  "do we still match the Python reference?".

## Status

| Property                  | Status                                                    |
|---------------------------|-----------------------------------------------------------|
| TS port                   | Shipped at `../src/drain.ts`, integrated via              |
|                           | `DrainChunkPolicy`, `ColumnarDrainPolicy`,                |
|                           | `TypedColumnarDrainPolicy`                                |
| Rust port (workspace)     | `packages/o11y-codec-rt/drain/`                           |
| Cross-validation          | TS ≡ Rust ≡ published Python reference (ARI = 1.0 on 5)   |
| Native throughput (Rust)  | 0.9–3.3 M logs/s (measured on the prototype build)        |
| WASM size                 | Prototype binding measured 6.7 KB gz; the new binding     |
|                           | crate at `packages/o11ylogsdb/rust/` is not yet wired up  |
| Masker (number / IP)      | Pure-Rust scaffolding ready; *no instructions installed   |
|                           | by default* — host installs masking explicitly            |
| Persistable state         | *Pending* — M3 concern, but the API accommodates it       |
| `LogParser` trait         | *Pending* — currently a concrete `Drain` struct           |

## Configuration

Default `depth = 4`, `sim_th = 0.4`, `max_children = 100`,
`parametrize_numeric_tokens = true`. Tuned to match the Python
reference's defaults so cross-validation holds. Configurable via
`Config`:

```rust
use o11y_codec_rt_drain::{Config, Drain};

let mut d = Drain::new(Config::default());
let cluster_id = d.add_line("user 42 logged in");
```

## What's pending

The graduation lifted the pure logic and removed the prototype's
WASM scaffolding. Outstanding items, in priority order:

1. **Build a real `o11ylogsdb-rust.wasm`.** When the engine wants
   the Rust fast path, create `packages/o11ylogsdb/rust/` with a
   thin binding crate (panic_handler, bump allocator, `extern "C"`
   exports) that depends on `o11y-codec-rt-drain` and re-exports the
   parser via the C ABI. The previous prototype's scaffolding is in
   git history if a starting template helps.
2. **`LogParser` trait** so future template extractors (LogPunk,
   XDrain, etc.) can slot in without touching the engine.
3. **Persistable state.** Snapshot/restore the prefix tree + cluster
   list so chunk-close → chunk-open round-trips don't lose template
   IDs.
4. **Configurable masker.** Number / IP / hex prefix patterns called
   from the host, matching how `BodyClassifier` plugs in at the
   engine level.

## Why one port per language

Both implementations exist for the dual-implementation protocol the
o11ykit family follows: TypeScript and Rust→WASM, mutual oracles,
cross-validated on every PR. The Rust port is the fast path; the TS
port is the always-available fallback for the read query path
(decoded chunks need Drain to reconstruct templated bodies even when
the WASM module isn't loaded).
