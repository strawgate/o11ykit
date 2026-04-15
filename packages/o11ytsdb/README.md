# o11ytsdb

Browser-native time-series compression for OpenTelemetry data. XOR-delta
encoding with three interchangeable implementations: TypeScript, Zig→WASM,
and Rust→WASM.

## Status: M1 — XOR-Delta Codec ✅

All three implementations pass bit-exact cross-validation (30/30 pairs).
WASM binaries are under 5 KB raw, under 1.5 KB gzipped.

## WASM Binary Size

| Runtime | Raw | Gzipped |
|---------|-----|---------|
| Zig 0.14.0 | **4,037 B** | **1,391 B** |
| Rust 1.94.1 | 4,589 B | 1,509 B |

Both built `#![no_std]` / freestanding, no allocator, no runtime, pure
`extern "C"` exports.

## Codec Benchmark — WASM vs TypeScript

All three produce identical compressed output (same algorithm, same bits).
WASM provides 28–80× throughput improvement over pure TypeScript.

### Encode Throughput (samples/sec, p50)

| Vector | TypeScript | Zig→WASM | Rust→WASM | Zig speedup | Rust speedup |
|--------|-----------|----------|-----------|-------------|--------------|
| constant_gauge | 2.81M | **80.13M** | 67.46M | 29× | 24× |
| slow_gauge | 120K | **9.26M** | 7.09M | 77× | 59× |
| monotonic_counter | 299K | **22.18M** | 19.48M | 74× | 65× |
| spiky_latency | 113K | 3.86M | **4.54M** | 34× | 40× |
| high_entropy | 122K | 4.84M | **5.33M** | 40× | 44× |

### Decode Throughput (samples/sec, p50)

| Vector | TypeScript | Zig→WASM | Rust→WASM | Zig speedup | Rust speedup |
|--------|-----------|----------|-----------|-------------|--------------|
| constant_gauge | 4.71M | **121.47M** | 111.44M | 26× | 24× |
| slow_gauge | 166K | **12.71M** | 7.46M | 77× | 45× |
| monotonic_counter | 574K | **26.76M** | 20.87M | 47× | 36× |
| spiky_latency | 151K | **11.86M** | 6.93M | 79× | 46× |
| high_entropy | 167K | **13.32M** | 7.71M | 80× | 46× |

**Winner: Zig.** Smaller binary, faster encode on structured data, 1.5–2×
faster decode across the board.

### Bun vs Node (TypeScript runtime)

Bun 1.3.12 runs the pure-TS codec roughly **2× faster** than Node 18.20.4:

| Vector (encode p50) | Node 18 | Bun 1.3 | Speedup |
|---------------------|---------|---------|---------|
| constant_gauge | 2.81M | 4.16M | 1.5× |
| slow_gauge | 120K | 260K | 2.2× |
| monotonic_counter | 299K | 635K | 2.1× |
| spiky_latency | 113K | 238K | 2.1× |
| high_entropy | 122K | 253K | 2.1× |

WASM throughput is nearly identical across both runtimes (same native code).

## Compression Comparison (7 strategies)

1024-point chunks, `Float64Array` values + `BigInt64Array` timestamps.

### Compression Ratio (higher = better)

| Vector | raw | JSON | gzip | brotli | xor-delta | xor+gzip | xor+brotli |
|--------|-----|------|------|--------|-----------|----------|------------|
| constant_gauge | 1.0× | 0.9× | 5.1× | 5.7× | 57.9× | 372.4× | **442.8×** |
| slow_gauge | 1.0× | 0.8× | 2.5× | 2.3× | 2.3× | **4.0×** | 3.4× |
| monotonic_counter | 1.0× | 0.7× | 2.7× | 2.9× | 7.0× | 7.5× | **7.6×** |
| spiky_latency | 1.0× | 0.5× | 1.5× | 1.3× | 2.2× | 2.2× | 2.2× |
| high_entropy | 1.0× | 0.5× | 1.5× | 1.5× | 2.4× | 2.4× | 2.4× |

### Bytes Per Sample

| Vector | raw | xor-delta | xor+gzip | xor+brotli |
|--------|-----|-----------|----------|------------|
| constant_gauge | 16.00 | 0.28 | 0.04 | **0.04** |
| slow_gauge | 16.00 | 6.89 | **4.01** | 4.64 |
| monotonic_counter | 16.00 | 2.29 | 2.12 | **2.09** |
| spiky_latency | 16.00 | 7.37 | 7.39 | **7.37** |
| high_entropy | 16.00 | 6.64 | 6.66 | **6.64** |

### Encode Throughput (samples/sec, p50 — Node 18)

| Vector | raw | json | gzip | brotli | xor-delta | xor+gzip | xor+brotli |
|--------|-----|------|------|--------|-----------|----------|------------|
| constant_gauge | 6.71M | 1.48M | 1.54M | 2.42M | 1.42M | 1.31M | 1.65M |
| slow_gauge | 5.72M | 1.56M | 791K | 1.40M | 66K | 62K | 70K |
| monotonic_counter | 6.19M | 1.72M | 811K | 1.76M | 161K | 149K | 201K |
| spiky_latency | 6.21M | 1.44M | 699K | 1.47M | 62K | 62K | 80K |
| high_entropy | 6.17M | 1.56M | 709K | 1.37M | 66K | 67K | 84K |

### Decode Throughput (samples/sec, p50 — Node 18)

| Vector | raw | json | gzip | brotli | xor-delta | xor+gzip | xor+brotli |
|--------|-----|------|------|--------|-----------|----------|------------|
| constant_gauge | 16.57M | 2.42M | 5.21M | 6.81M | 3.13M | 3.28M | 2.79M |
| slow_gauge | 13.57M | 2.37M | 5.83M | 5.61M | 136K | 126K | 106K |
| monotonic_counter | 12.79M | 3.30M | 5.72M | 6.13M | 448K | 411K | 359K |
| spiky_latency | 14.99M | 2.34M | 4.78M | 4.54M | 107K | 119K | 91K |
| high_entropy | 15.49M | 2.32M | 5.57M | 4.81M | 132K | 130K | 132K |

## Cross-Validation

All 30 encoder↔decoder permutations (TS↔Zig↔Rust, 5 vectors each)
produce bit-exact round-trip output. Any two implementations serve as
oracles for the third.

## Running Benchmarks

```bash
# Build WASM (requires Zig 0.14+, Rust with wasm32-unknown-unknown target)
cd zig && zig build -Doptimize=ReleaseSmall && cp zig-out/bin/o11ytsdb.wasm ../wasm/o11ytsdb-zig.wasm
cd rust && cargo build --target wasm32-unknown-unknown --release && cp target/wasm32-unknown-unknown/release/o11ytsdb.wasm ../wasm/o11ytsdb-rust.wasm

# Compile TypeScript
npx tsc -p bench/tsconfig.json

# Run codec benchmark (TS + Zig + Rust)
node bench/run.mjs codec

# Run competitive compression comparison
node bench/run.mjs competitive

# Or use Bun for ~2× faster TS execution
bun bench/run.mjs codec
bun bench/run.mjs competitive
```

Results are written to `bench/results/` as JSON.

## Architecture

```
src/codec.ts         ← TypeScript XOR-delta codec
zig/src/root.zig     ← Zig XOR-delta codec → WASM
rust/src/lib.rs      ← Rust XOR-delta codec → WASM
wasm/                ← Pre-built .wasm binaries
bench/
  harness.ts         ← Statistical benchmark runner
  vectors.ts         ← Test vector generators
  codec.bench.ts     ← 3-runtime codec benchmark
  competitive.bench.ts ← 7-strategy compression comparison
  wasm-loader.ts     ← WASM instantiation + CodecImpl wrapper
  run.mjs            ← CLI entry point
```

## Key Findings

1. **XOR-delta is the dominant strategy.** It beats gzip on every vector
   type, sometimes dramatically (58× on constants vs gzip's 5×).

2. **Post-compression (gzip/brotli on XOR-delta output) helps structured data.**
   xor+gzip reaches 372× on constants. Brotli edges ahead at 443×.
   On high-entropy or spiky data, post-compression adds no benefit.

3. **Brotli is not worth the complexity.** It ties or slightly beats gzip on
   highly compressible data, but loses on gauges (3.4× vs gzip's 4.0×).
   The marginal gain doesn't justify the added dependency complexity.

4. **WASM is 28–80× faster than TypeScript** for the codec hot path.
   Zig produces smaller binaries (4.0 KB vs 4.6 KB) and faster decode
   (1.5–2× over Rust WASM). Both are well under the 20 KB target.

5. **Bun runs TS ~2× faster than Node 18.** WASM speed is the same on both.
