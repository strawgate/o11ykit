# Next-generation compression for in-browser time series metrics engines

**Achieving sub-0.3 bytes/sample lossless compression for OTLP metrics in a TypeScript + Rust/WASM stack is feasible on typical monitoring workloads—but only with batched, multi-layer compression that exploits the specific structure of monitoring data.** No single algorithm reaches this target alone. The critical path combines VictoriaMetrics-style decimal-to-integer conversion, type-aware delta encoding, and entropy coding (Pcodec or ZSTD), applied to blocks of 1024+ samples with shared timestamp columns across co-scraped series. The information-theoretic floor for mixed node_exporter-type data sits at approximately **0.25–0.6 B/sample**, making the 0.3 target near-optimal. For lossy visualization storage at 0.1 B/sample, the combination of M4/MinMaxLTTB temporal downsampling, Float16 precision reduction, and XOR delta encoding is immediately implementable with existing Rust crates targeting WASM.

The remainder of this report provides full algorithmic details, measured performance data, and implementation guidance across all eight research areas, organized by estimated impact to a browser-based OTLP metrics engine ingesting 1K–100K concurrent series with 1–24 hour retention.

---

## Floating-point compression has moved beyond XOR chains

The field has decisively shifted from Gorilla-style sequential XOR (2015) toward **decimal-aware integer conversion**, driven by the insight that monitoring floats originate from human-set decimal values. Three techniques dominate.

**ALP (Adaptive Lossless floating-Point, Afroozeh & Boncz, CWI Amsterdam, SIGMOD 2024)** exploits the fact that most monitoring floats began as decimals (CPU at 45.2%, latency at 12.5ms). ALP multiplies each value by 10^e to recover the original integer, then applies Frame-of-Reference + bit-packing via the FastLanes layout. Per-1024-value adaptivity selects optimal exponents through a two-level sampling scheme (8 vectors per row-group, 32 values per vector). Values failing the decimal round-trip (~0–18%) are stored as exceptions. ALP achieves **44× faster scans than Gorilla, 64× faster than Chimp**, with ~50% better compression ratio. The ALP-RD variant handles non-decimal floats by dictionary-encoding the upper ~48 bits and bit-packing the lower bits. DuckDB replaced Chimp128 and Patas with ALP in v0.10.0 (February 2024). The MIT-licensed C++ header-only library at `github.com/cwida/ALP` uses no SIMD intrinsics—it auto-vectorizes through simple loops, making Rust/WASM compilation straightforward. Measured: **~1.0–2.0 B/sample on monitoring data, decoding at ~2.6 doubles/CPU cycle**.

**Pcodec (Loncaric, Jeppesen & Zinberg, arXiv:2502.06112, February 2025)** takes a fundamentally different approach with a three-step pipeline: mode selection (Classic, IntMult, FloatMult, FloatQuant), optional delta encoding, then a novel *binning* algorithm that partitions the integer space and assigns Huffman codes per bin plus offset. This binning provably converges to true SIID entropy with O(1/k) excess bits for k bins. Written in Rust—it compiles directly to WASM. Measured: **29–94% higher compression ratio** than Blosc2+Zstd, Parquet+Zstd, and TurboPFor across 6 real-world datasets, decompressing at **>1 GiB/s** per thread. The constraint: Pcodec requires batch processing (chunks of up to 262K values) and a full analysis pass per chunk, making it unsuitable for per-sample streaming but excellent for background compaction of accumulated blocks.

**DeXOR (Yao, Chen, Fang, Gao, Jensen & Li, arXiv:2601.00695, January 2025)** introduces decimal-space XOR—operating on decimal string representations rather than IEEE 754 binary. For consecutive values like 64.5487→64.56, it extracts the longest common decimal prefix ("64.5"), scales the residual to remove redundancy, and encodes prefix length + scaled difference. An exception handler based on exponential subtraction covers extreme cases. Measured: **15% higher compression ratio** than the best competitor (Camel) across 22 datasets, with **20% faster decompression**. DeXOR achieves **~0.9–1.25 B/sample** on monitoring data in true streaming mode with O(1) memory per series. Integrated into Apache IoTDB but no standalone open-source implementation yet—a Rust port is required.

Other notable FP techniques: **FPC (Burtscher & Ratanaworabhan, IEEE TC 2009)** uses dual FCM/DFCM hash-table predictors running in parallel, selecting whichever predicts better per value. For monitoring data, expect ~2–3 B/sample—it doesn't exploit decimal structure. Hash tables of **2^16 entries × 8 bytes × 2 tables = 1MB** are optimal. **Byte-shuffle (Blosc-style)** rearranges N float64 values so all first bytes are contiguous, all second bytes contiguous, etc., creating 8 homogeneous streams that compress well with LZ4/Zstd. Blosc2's `bytedelta` filter achieves median **5.86× compression** on floats. **Neural/learned compression** (NeaTS, ICDE 2025; Transformer-based predictors) is categorically **not viable** for sub-ms WASM decompression—even a tiny 3-layer MLP requires ~10K MACs per value, translating to 10–100ms for 100K samples in WASM.

---

## FastLanes is the unifying integer compression framework for WASM

**FastLanes (Afroozeh & Boncz, VLDB 2023)** solves the critical problem of making SIMD-accelerated integer compression portable to WASM. The paper introduces two innovations: a virtual 1024-bit register design that decomposes to any physical SIMD width (including WASM's 128-bit), and a transposed "04261537" ordering that eliminates cross-lane data dependencies in delta/FOR/RLE decoding. Traditional delta decoding is sequential—each value depends on the previous. FastLanes reorders tuples so dependent values always fall within the same SIMD lane, enabling fully independent per-lane processing with O(log(N/lanes)) fixup operations. The result: **>100 billion integers/second** on modern CPUs, with scalar code matching explicit SIMD intrinsics when auto-vectorized by LLVM.

For WASM specifically, FastLanes is exceptionally well-suited because it requires **no SIMD intrinsics**—only basic arithmetic (add, shift, AND, OR) that LLVM auto-vectorizes to `v128` instructions when compiled with `-msimd128`. The Rust crate `spiraldb/fastlanes` (Apache 2.0, 981 SLoC, 203K+ downloads on crates.io) provides pure Rust implementations supporting u8/u16/u32/u64 at arbitrary bit widths. Compiling to `wasm32-unknown-unknown` with WASM SIMD produces 4×32-bit or 2×64-bit lane processing per instruction—a structural 2× disadvantage versus AVX2 but a **1.5–2.5× speedup over scalar WASM**.

For **timestamp compression**, the optimal pipeline is: delta encoding → delta-of-delta → ZigZag → check for constant delta (pure RLE: 3 values for entire column) → otherwise FOR + FastLanes bit-packing. For regular 15-second intervals with ms jitter, delta-of-delta values are mostly 0, compressing to **~0.05–4 bits/timestamp**. For **monotonic counter values**: delta encoding produces non-negative increments → FOR (subtract minimum) → FastLanes bit-packing at **4–8 bits per value** for slowly-growing counters.

**Simple-8b with RLE** remains optimal for pure timestamp sequences: it packs up to 60 zero-bit integers per 64-bit word and the RLE variant handles constant-delta intervals at near-zero cost. After delta-of-delta encoding, 96% of timestamps compress to a single bit (per the original Gorilla paper). Implementation is trivial (~200 lines of Rust) and purely scalar. The GCD optimization (used by CnosDB, InfluxDB, TimescaleDB) divides all deltas by their common GCD before encoding—for timestamps at exact 15-second intervals, this reduces all deltas to 1, enabling pure RLE.

**Roaring Bitmaps** via `roaring-rs` (pure Rust, WASM-compatible, no FFI) are the recommended data structure for label-based series lookup. Each unique label-value pair gets a Roaring bitmap of matching series ordinal IDs. Multi-label queries become bitmap intersections—O(min(|A|, |B|)) with SIMD acceleration. For 100K series, the entire label index fits in **<100KB** and intersection takes microseconds. Used by Druid (60% query acceleration), InfluxDB, ClickHouse, and Google Procella.

---

## Shared timestamps and histogram delta encoding yield the largest cross-series wins

**Shared timestamp columns** are the single highest-impact cross-series optimization. The Heracles system (Wang, Xue & Shao, PVLDB 14(6), 2021) demonstrated **+171% insertion throughput, −32% query latency, −30% space** versus Prometheus TSDB by grouping co-scraped series under a single timestamp array. In OTLP, metrics from the same SDK export batch naturally share timestamps. Implementing shared timestamps per ResourceMetrics batch eliminates ~50% of timestamp storage redundancy, yielding **~30% overall space savings** with near-zero computational overhead—directly applicable to browser WASM.

For **histogram compression**, the critical technique is double-delta encoding across two dimensions. First, delta-encode bucket counts *across buckets* within each snapshot (cumulative histogram counts are monotonically non-decreasing, so deltas are always ≥0). Then, delta-of-delta-encode each bucket's stream *across time*. Prometheus's native histogram chunk format (`varbit_int` encoding) implements exactly this, with spans for sparse bucket representation. For 112 populated buckets, 56 of the deltas fit in a single byte. OTLP exponential histograms add perfect subsetting: reducing scale by 1 merges every 2 adjacent buckets losslessly, enabling efficient cross-resolution merging at O(B) cost.

**DDSketch** is the recommended mergeable sketch format for the browser engine: fully mergeable (just sum corresponding bucket counters, O(B)), ~2KB for 2% relative accuracy covering 1ms–1min range, and protobuf-serializable. UDDSketch improves on DDSketch with formal accuracy guarantees after bucket collapsing—critical for long-running browser sessions where sketches accumulate across many merge operations.

Inter-series correlation compression (CORAD, ModelarDB) achieves **up to 113× compression** but requires O(N²) pairwise correlation computation—prohibitively expensive for 100K series in a browser. Skip this for the initial implementation. The derived time series concept from ModelarDB is worth selectively applying: if `cpu_user + cpu_system + cpu_idle = 100` is known, store only 2 series and derive the third.

---

## Lossy visualization compression reaches 0.1 B/sample through layered reduction

**M4 aggregation (Jugel et al., PVLDB 2014)** produces pixel-perfect line charts by retaining 4 values per pixel-width bucket: first, last, min, max. For a 1920px chart viewing 24 hours of 10-second data (8,640 raw points), M4 emits ≤7,680 points—the rendered chart is mathematically identical to plotting all raw data. The algorithm is a single O(n) pass of comparisons, embarrassingly parallel, and SIMD-optimizable. The follow-up M4-LSM (SIGMOD 2024) deploys M4 efficiently on LSM-tree storage in Apache IoTDB.

**MinMaxLTTB (Van Der Donckt et al., IEEE VIS 2023)** combines M4's extrema preservation with LTTB's perceptual smoothness in a two-step hybrid. Step 1: MinMax preselection divides data into `n_out × 4` buckets and extracts min/max candidates (parallelizable, SIMD-optimized). Step 2: LTTB selects the perceptually optimal point per output bucket from the preselected candidates. This fixes LTTB's tendency to miss extreme values while maintaining its shape preservation. The `tsdownsample` Rust library achieves **near-memory-bandwidth performance**: 10M float64 points → 1000 output in ~2ms. The `minmaxlttb-rs` crate provides a ready-to-use Rust/WASM implementation.

**Achieving <0.1 B/sample** requires multiplicative compression layers:

- **Temporal downsampling** (M4 at 1-minute buckets on 10-second data): 6× reduction, storing min/max/first/last per minute
- **Precision reduction** (Float64→Float16): 4× reduction; for monitoring metrics in typical ranges (0–100%, 0–10,000ms), charts are **visually indistinguishable** at Float16's 3-digit mantissa precision
- **Delta/XOR encoding** on reduced values: 2–4× reduction; XOR of consecutive Float16 values produces abundant leading zeros
- **Entropy coding** (Huffman or varint): 1.5–2× additional

Combined: 16 B/sample raw → 2.67 (temporal) → 0.5 (precision) → 0.17 (XOR delta) → **~0.11 B/sample**. Breaking 0.1 requires slightly more aggressive temporal downsampling (10s→5min = 30×, yielding ~0.05 B/sample) or multi-resolution tiering where older data uses coarser resolution.

The recommended **multi-resolution architecture**:

| Tier | Resolution | Retention | Format | Amortized B/sample |
|------|-----------|-----------|--------|-------------------|
| 0 (Hot) | Raw samples | Last 5 min | Gorilla-compressed Float32 | ~2.0 |
| 1 (Warm) | 1-min M4 buckets | 2 hours | Float16 min/max/first/last | ~0.13 |
| 2 (Cool) | 5-min M4 buckets | 24 hours | Float16 min/max | ~0.013 |

---

## Cache-conscious chunking and arena allocation for WASM linear memory

**Optimal chunk size is 120–256 samples.** Prometheus's validated default of 120 samples per chunk places the compressed block (~165 bytes at 1.37 B/sample Gorilla encoding) within **3 cache lines** (64B each), ensuring L1 residency during decompression. For FastLanes-based codecs, 1024 values per batch is the natural unit but can be split into sub-chunks of 128 for cache-friendliness. Columnar layout within chunks—timestamps contiguous, then values contiguous—maximizes cache-line utilization: 8 timestamps per 64-byte line versus 4 timestamp-value pairs in row layout.

**Arena-per-epoch allocation** is the critical memory management strategy for WASM. WASM linear memory can only grow (never shrink), and `memory.grow` causes **ArrayBuffer detachment** on the JS side—all TypedArray views become invalid. The SQLite WASM team documented catastrophic heap fragmentation from malloc/free cycles: after 80MB of fragmented heap, large allocations fail permanently. The solution: pre-allocate large arenas at startup, use bump allocation within each arena (O(1), zero fragmentation), and organize arenas as a ring per epoch (e.g., 1-hour segments). When the oldest epoch expires, reset its arena pointer to 0—instant bulk deallocation. Never use general-purpose malloc/free for time series data.

**Zone maps** (min/max indexes per compressed chunk) enable skip-scan without decompression. Each chunk stores ~32 bytes of metadata: `{min_timestamp, max_timestamp, min_value, max_value, count, sum}`. Before decompressing any chunk, check if the query's time range overlaps with [min_ts, max_ts]. TimescaleDB reports **up to 7× faster scans** with zone map pruning on compressed data. For 100K series × 24h retention with 30-minute chunks = ~4.8M chunk descriptors—but hierarchical zone maps (per-hour, then per-chunk) reduce this to a practical size.

For **label-based series lookup**, a flat array-based compressed radix trie in WASM linear memory with Roaring Bitmap posting lists provides O(1) hash lookup for exact-match queries and efficient intersection for multi-label queries. Prometheus uses `MemPostings`—sharded maps from label name/value pairs to sorted posting lists with 16,384 stripe locks for concurrency. For a browser engine, string interning with ID-based series identity is simplest: label name dictionary (small, static) + label value dictionary (larger, growing) + series identity as sorted array of (name_id, value_id) pairs at ~4 bytes per label pair. Total metadata for 100K series: **~3–5MB**.

---

## WASM SIMD delivers 1.5–2.5× over scalar, and SharedArrayBuffer enables multi-worker pipelines

**WASM SIMD (128-bit)** is universally supported: Chrome 91+, Firefox 89+, Safari 16.4+. Benchmarks show WASM SIMD provides **1.5–2.5× speedup** over scalar WASM for bit-packing, delta decoding, and XOR operations. Compared to native AVX2 (256-bit), WASM SIMD is roughly 2–4× slower for throughput-bound operations—a structural consequence of 128-bit versus 256-bit register width. For compression hot paths, the `v128.xor` instruction directly accelerates Gorilla-style XOR encoding, and FastLanes auto-vectorization produces efficient 4×32-bit lane processing without intrinsics.

**SharedArrayBuffer** enables the critical multi-worker architecture:

```
Ingestion Worker → SharedArrayBuffer (compressed chunk store) ← Rendering Worker
                          ↑
                  Compression Worker
```

`WebAssembly.Memory` created with `shared: true` backs directly onto SharedArrayBuffer. Rust compiled with `-C target-feature=+atomics` enables `std::thread` compiled to WASM threads. Recent benchmarks show **up to 3.5× improvement** for compute-heavy tasks using WASM threads + SharedArrayBuffer versus single-threaded WASM. The cross-origin isolation requirement (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) is mandatory and well-supported.

**CompressionStream API** (gzip, deflate) is **unsuitable for hot-path compression** of 512B–4KB blocks. The async stream pipeline setup overhead (~0.5–2ms per small block) dominates actual compression work. Use it only for batch export/persistence of accumulated larger buffers (>64KB) during idle periods.

**WebGPU compute** is **not viable** for chunk-level decompression. GPU dispatch overhead (buffer upload + shader dispatch + readback) exceeds computation for typical chunk sizes (128–4096 values). WebGPU wins only for batched operations on >256×256 matrices with data staying GPU-resident between operations. Additionally, WGSL lacks native 64-bit integers, complicating timestamp handling.

For **Rust-to-WASM hot paths**, avoid wasm-bindgen for large array transfers. Instead, use direct linear memory access: export buffer pointers from Rust, write/read directly via `Uint8Array` views over `wasm.memory.buffer`. Pre-allocate static buffers in Rust (`static mut BUFFER: [u8; 65536] = [0; 65536]`) and minimize boundary crossings—perform all compression work (delta + XOR + bit-packing) in a single WASM call. Re-create TypedArray views only when `memory.grow` occurs. Recommended Cargo profile: `opt-level = 's'`, `lto = true`, `codegen-units = 1`.

For TypedArray GC mitigation on the JS side: pre-allocate TypedArray pools (reducing GC time from ~50ms to ~10ms), use resizable ArrayBuffers (ES2024) where supported, and keep all time series data in WASM linear memory (outside V8 GC). Only lightweight JS wrapper objects should be GC-managed. V8 v8.3+ introduced concurrent ArrayBuffer backing store tracking, reducing GC pause time by **50%** in ArrayBuffer-heavy workloads.

---

## Compressed computation and block-level aggregates eliminate decompression for dashboards

For the common dashboard query pattern (aggregate 100K samples into a single number), **pre-computed block aggregates** are the highest-impact optimization. Store 32 bytes of metadata per compressed block: `{min, max, sum, count, first, last, min_ts, max_ts}`. Queries spanning complete blocks read only metadata—**zero decompression**. For partial blocks at range boundaries, decompress only those blocks.

**Codec-specific query shortcuts** enable further optimization: RLE-encoded data supports `count(range)` as sum of run lengths (O(runs) not O(samples)). FOR-encoded data supports `sum = n × reference + Σ(offsets)` computed directly on bit-packed offsets via SIMD horizontal add. Delta-encoded data enables O(1) range sums with pre-computed prefix sums. A 1-byte codec tag per block enables the query engine to select the optimal execution strategy per block. CompressIoTDB (VLDB 2025) demonstrates **15.8% latency improvement** for queries computed on compressed data versus decompress-first approaches, with up to 39% on high-compression-ratio datasets.

For streaming ingestion at 100K concurrent series, per-series compression state must be bounded. Gorilla requires **~24–30 bytes per series** (previous timestamp delta, previous value, previous XOR leading/trailing zero counts, output buffer pointer). At 100K series: **2.4–3MB total state**—well within browser constraints. DeXOR requires ~64 bytes per series for its decimal prefix tracking. The key architectural insight: stream samples into per-series ring buffers using lightweight Gorilla-style encoding (~1.0–1.7 B/sample), then run background compaction that recompresses accumulated blocks with heavier codecs (ALP, Pcodec, or ZSTD-layered) achieving ~0.4–0.8 B/sample.

---

## The path to 0.3 B/sample lossless requires the VictoriaMetrics recipe adapted for WASM

VictoriaMetrics' reported **~0.4 B/sample** uses a three-layer stack: (1) float64→integer conversion via decimal scaling (slightly lossy at >12 significant digits), (2) type-aware delta encoding (nearest-delta for gauges, double-delta for counters, constant detection), (3) ZSTD general-purpose compression on the encoded integer stream. The 0.4 B/sample figure is **on-disk with ZSTD on top and near-lossless precision**. Without ZSTD, expect ~1.5–2.0 B/sample.

For a WASM implementation targeting <0.3 B/sample, the adapted recipe:

- **Decimal-to-integer conversion** (ALP-style): multiply by 10^e, yielding integers with up to 12 significant digits. This is near-lossless for monitoring metrics—values like 45.2% or 12.5ms convert perfectly
- **Type-aware encoding**: detect constant series (0 bits/sample beyond value + count), constant-delta counters (store delta once), monotonic counters (delta → FOR + bit-pack), gauges (nearest-delta → FOR + bit-pack)
- **Shared timestamp columns**: one timestamp array per scrape batch, eliminating ~50% of timestamp overhead
- **Batch entropy coding**: Pcodec binning or ZSTD on blocks of 1024+ integer residuals
- **Cross-series batching**: group same-resource series for joint compression

Real-world monitoring data characteristics validate this approach: **30–50% of monitoring samples repeat the previous value** (XOR = 0, encoded as 1 bit). Counter deltas during idle periods are 50–90% zeros. Many node_exporter series are constant or constant-delta for extended periods. The weighted empirical entropy of mixed monitoring workloads is **~2–5 bits/sample (0.25–0.6 B/sample)**, confirming that the 0.3 B/sample target sits near the information-theoretic floor.

Compression ratio composition follows a **~70% of multiplicative ideal** rule: domain-specific encoding captures 60–80% of compressibility (3–10×), entropy coding captures 50–80% of the remainder (2–5× additional), and a third layer rarely adds >20%. Two well-chosen orthogonal layers are the sweet spot. The ClickHouse pattern demonstrates this: type optimization (3.75×) + domain codecs (2–4×) + ZSTD (2–3×) = ~32× total versus a theoretical multiplicative product of 45×.

---

## Synergistic technique combinations and the recommended full architecture

The highest-impact combination for the browser OTLP engine, organized by compression pipeline stage:

**Ingestion (per-sample, O(1) state):** String-interned label lookup → series ID hash (O(1)) → streaming DeXOR or Gorilla compression (24–64 bytes state/series) → block boundary at 128 samples triggers block aggregate computation (min, max, sum, count)

**Background compaction (per-block, batched):** ALP decimal-to-integer conversion → type-aware delta encoding (auto-detect counter/gauge/constant via monotonicity and variance) → FastLanes FOR + bit-packing on integer residuals → optional Pcodec binning or lightweight entropy coding for additional 1.5–2× gain

**Cross-series optimization:** Shared timestamp columns per OTLP ResourceMetrics batch → per-block adaptive codec selection from {Constant, RLE, Gorilla-XOR, FOR+BitPack} with 1-byte codec tag → zone map metadata per chunk for skip-scan

**Visualization path:** Query determines pixel-width → select appropriate resolution tier → if tier granularity < pixel granularity, apply MinMaxLTTB in WASM SIMD → Float16 output for rendering → WebGL/Canvas

| Component | Library/Approach | WASM Ready | B/sample |
|-----------|-----------------|-----------|----------|
| Timestamps | Shared columns + delta-delta + Simple-8b-RLE | ✅ | ~0.01–0.05 |
| Float values (streaming) | DeXOR or Gorilla | ✅ | ~0.9–1.74 |
| Float values (batched) | ALP + FastLanes bit-packing | ✅ | ~0.5–1.3 |
| Float values (batched + entropy) | Decimal conversion + Pcodec | ✅ (Rust native) | ~0.3–0.8 |
| Histograms | Cross-bucket delta + cross-time delta-delta | ✅ | ~0.5–1.0 per bucket |
| Lossy visualization | MinMaxLTTB + Float16 + multi-tier | ✅ (tsdownsample) | ~0.05–0.13 |
| Label index | Radix trie + Roaring bitmaps | ✅ (roaring-rs) | ~3–5MB total |
| Series state | 24-byte Gorilla state × 100K series | ✅ | 2.4MB total |

**Memory budget for 100K series, 1-hour retention at 15-second intervals:**

- Series metadata (interned labels): ~3–5MB
- Compression state (streaming): 24B × 100K = 2.4MB
- Compressed data at ~0.5 B/sample (batched): 100K × 240 samples × 0.5B = **12MB**
- At ~1.3 B/sample (streaming Gorilla): 100K × 240 × 1.3 = **31MB**
- Block aggregates + zone maps: ~2MB
- Label index (Roaring bitmaps): ~1MB
- **Total: ~20–42MB**—comfortably within browser constraints

## Conclusion

The compression landscape for monitoring metrics has undergone a fundamental shift from binary-XOR techniques toward **decimal-aware, type-specialized, multi-layer pipelines**. Three findings stand out as non-obvious. First, FastLanes' transposed layout that eliminates cross-lane SIMD dependencies is the critical enabler for WASM—it makes integer compression portable across any SIMD width without intrinsics, and the existing Rust crate compiles directly to wasm32. Second, the 0.3 B/sample lossless target is achievable on typical monitoring workloads because **30–50% of samples are repeats and many series are constant**, but this requires batched compression with entropy coding—not streaming per-sample encoding, which floors at ~0.9 B/sample (DeXOR). Third, the combination of M4 temporal downsampling and Float16 precision reduction is multiplicatively powerful for visualization: charts are provably identical (M4) or perceptually indistinguishable (Float16) while achieving 0.05–0.13 B/sample—well below the 0.1 lossy target.

The most impactful techniques for immediate implementation, ranked: (1) shared timestamp columns across co-scraped series, (2) type-aware codec selection per block (constant/RLE/delta/XOR), (3) FastLanes bit-packing for integer residuals via `spiraldb/fastlanes`, (4) ALP decimal-to-integer conversion for float values, (5) MinMaxLTTB with Float16 for visualization tiers. Together, these five techniques—all implementable in Rust/WASM with existing crates—should achieve ~0.3–0.5 B/sample lossless and ~0.1 B/sample lossy on representative monitoring workloads, with sub-ms decompression for 100K samples through WASM SIMD auto-vectorization.