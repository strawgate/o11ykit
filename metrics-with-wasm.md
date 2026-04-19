Here are the tricks that actually matter for this engine, ordered by impact:

**1. Multi-instance module cloning — near-free parallelism**

`WebAssembly.compile()` is expensive (parse + validate + JIT). But once you have a compiled `WebAssembly.Module`, instantiating it is nearly free (~microseconds). You can create the module once, then stamp out instances across Web Workers — each with its own scratch buffer, zero code duplication.

```typescript
// Compile once on main thread
const module = await WebAssembly.compileStreaming(fetch('engine.wasm'));

// Spin up N workers, each gets its own instance for ~0 cost
for (const worker of workers) {
  worker.postMessage({ module }); // Module is transferable
}

// In worker:
const instance = await WebAssembly.instantiate(module, imports);
// Own scratch buffer, own stack, shared code pages
```

This gives you a fan-out architecture: main thread manages the chunk store, workers each get a WASM instance and process queries in parallel. Since your chunks are independent per-series, query evaluation is embarrassingly parallel — each worker processes a shard of matching series.

**2. `memory.copy` and `memory.fill` bulk operations**

These are single WASM instructions that replace what would be a JS-side `TypedArray.set()` loop. When you copy a chunk into the scratch buffer:

```rust
// This compiles to a single memory.copy instruction
// which the engine can implement as a memcpy/memmove
core::ptr::copy_nonoverlapping(src, dst, len);

// And zeroing the scratch between uses:
core::ptr::write_bytes(scratch_ptr, 0, SCRATCH_SIZE);
// → memory.fill instruction, not a loop
```

These are 2–5× faster than byte-at-a-time loops because the engine can use the host's optimized memcpy.

**3. SIMD for the actual hot paths — but pick the right ones**

128-bit SIMD is universally supported (Chrome 91+, Firefox 89+, Safari 16.4+). The `v128` type gives you `f64x2` (2 doubles per instruction) and `f32x4` (4 floats). The operations that directly accelerate your engine:

- **`v128.xor`** — the core of Gorilla XOR chunk decoding. XOR two 128-bit values at once. Process 2 float64 XOR operations simultaneously in the decode loop.
- **`f64x2.min` / `f64x2.max`** — for computing `min_over_time` / `max_over_time` in a single pass over decompressed samples. 2× throughput.
- **`f64x2.add`** — accumulating sums for `avg_over_time`, `sum_over_time`. Pairwise accumulation in 2-wide vectors.
- **`i8x16.swizzle`** — byte-shuffling for FastLanes-style bit-unpacking, rearranging bytes during decompression.
- **`v128.load` / `v128.store`** — 16-byte aligned loads/stores, 4× throughput vs individual i32 loads for copying chunk data.

The critical point: **don't use SIMD intrinsics directly**. Write simple Rust loops and let LLVM auto-vectorize them. The `spiraldb/fastlanes` crate does this — no intrinsics, just carefully structured loops that LLVM recognizes. Compile with:

```toml
# .cargo/config.toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```

**4. Relaxed SIMD for FMA — faster rate() math**

Relaxed SIMD (shipped in Chrome 114+, Firefox 122+, Safari 16.4+) adds `f64x2.relaxed_madd` — fused multiply-add. The extrapolation step in `rate()` does `resultValue *= factor` then divides by duration. FMA merges the multiply+add into one instruction with better precision and throughput. Feature-detect it:

```rust
#[cfg(target_feature = "relaxed-simd")]
fn scale_and_rate(value: f64, factor: f64, duration_secs: f64) -> f64 {
    // FMA: (value * factor) + 0.0, then / duration
    // Compiler can emit f64x2.relaxed_madd
    (value * factor) / duration_secs
}
```

**5. `WebAssembly.Memory` with `shared: true` — the real multi-worker play**

Instead of each worker having its own scratch buffer, you can share one large memory:

```typescript
const memory = new WebAssembly.Memory({
  initial: 256,     // 16 MB
  maximum: 256,     // fixed — never grows
  shared: true      // backed by SharedArrayBuffer
});

// Every worker gets the same memory
for (const worker of workers) {
  worker.postMessage({ module, memory });
}

// In worker:
const instance = await WebAssembly.instantiate(module, {
  env: { memory } // all instances share this memory
});
```

Now you can write compressed chunks into shared memory from the ingestion worker, and query workers read them directly — zero-copy between workers. Use `Atomics.store` / `Atomics.load` on an index region to coordinate which chunks are valid. This requires COOP/COEP headers but eliminates the biggest bottleneck: serializing chunk data through `postMessage`.

**6. Streaming compilation — instant startup**

```typescript
// Don't do this:
const bytes = await fetch('engine.wasm').then(r => r.arrayBuffer());
const module = await WebAssembly.compile(bytes);

// Do this — compiles while downloading:
const module = await WebAssembly.compileStreaming(fetch('engine.wasm'));
```

Streaming compilation overlaps network download with JIT compilation. For a 500 KB WASM module, this cuts startup time from ~200 ms to ~50 ms. The compilation happens on a background thread.

**7. `memory.discard` — not ready yet, but watch it**

This is a Phase 1 proposal that would let WASM return physical pages to the OS by zeroing them. Semantically it's `memset(addr, 0, size)` but the OS reclaims the physical pages. This would be the actual fix for the "WASM memory only grows" problem — you'd call `memory.discard` on evicted chunk regions and the resident memory would drop. Not shipping in any browser yet, but it's the proposal most directly relevant to long-running metrics engines.

**8. Avoid `wasm-bindgen` for hot paths — use raw exports**

`wasm-bindgen` generates JS glue code with type conversions, string copying, and error wrapping. For the hot path (decompress chunk → aggregate), skip it entirely:

```rust
// Export raw functions — no wasm-bindgen
#[no_mangle]
pub extern "C" fn decompress_xor_chunk(
    in_ptr: u32,    // offset into scratch_in
    in_len: u32,    // compressed size
    out_ptr: u32,   // offset into scratch_out
) -> u32 {         // number of samples written
    // Pure pointer arithmetic, no allocations, no JS interaction
    unsafe {
        let input = core::slice::from_raw_parts(
            in_ptr as *const u8, in_len as usize
        );
        let output = core::slice::from_raw_parts_mut(
            out_ptr as *mut f64, SCRATCH_SIZE / 8
        );
        decode_xor(input, output)
    }
}
```

On the JS side, call it as `instance.exports.decompress_xor_chunk(0, len, SCRATCH_SIZE/2)`. No glue, no overhead, ~5 ns call overhead. Use `wasm-bindgen` only for the initial setup and non-hot-path APIs.

**9. Keep WASM module size small — split hot and cold**

Build two WASM modules: a small **hot module** (~50 KB) with just XOR decode, SIMD aggregations, and rate computation; and a larger **cold module** (~200+ KB) with ALP/Pcodec compression, FastLanes bit-packing, and MinMaxLTTB downsampling. Load the hot module synchronously at startup. Lazy-load the cold module in the background. First query can execute before the cold module finishes compiling.

**10. The multi-memory proposal (standardized in WASM 3.0)**

WASM 3.0 added support for **multiple memory instances** per module. You could have one memory for the scratch input buffer and a separate memory for scratch output — no pointer arithmetic to partition a single linear memory. More importantly, if one memory is shared and another isn't, you get fine-grained control over which data is visible to other workers. Chrome and Firefox support this; Safari support landed in 2025.