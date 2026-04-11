# Phase #180 Inventory: Benchmark-Specific vs. Generic Metric-Platform Behavior

This document catalogs the benchmark-specific vocabulary and assumptions baked into the current Benchkit codebase, as a foundation for separating the benchmark domain from the generic metric-platform infrastructure in Phase #180.

## 1. Benchmark Vocabulary & Core Concepts

These concepts represent the "Benchmark Domain" and are likely to remain benchkit-owned or form the basis for Benchkit-specific OTLP conventions.

- **Benchmark**: A named logical entity representing a single test or scenario.
- **Scenario**: The OTLP attribute (`benchkit.scenario`) used to group metrics into a benchmark.
- **Series**: The OTLP attribute (`benchkit.series`) used for sub-grouping (e.g., variant, batch size, or different implementations).
- **Metric**: A numeric measurement associated with a benchmark.
- **Direction**: `bigger_is_better` or `smaller_is_better`. This is the single most critical benchmark-specific metadata, as it defines what constitutes a "regression."
- **Regression / Improvement / Stable**: The specific terminology for benchmark results comparison.
- **Outcome vs. Diagnostic**: The classification of metrics to distinguish between the primary benchmark results ("Outcome") and background telemetry ("Diagnostic").

## 2. Parser Assumptions (`packages/format/src/parse*.ts`)

Parsers are the primary site of benchmark-specific "translation" logic.

### Heuristics and Metadata

- **Unit Normalization**: `unitToMetricName` encodes specific knowledge of benchmark units (e.g., `ns/iter`, `B/op`, `MB/s`) and normalizes them into standard metric keys (e.g., `ns_per_iter`).
- **Direction Inference**: `inferDirection` implements heuristic-based guessing of the "better" direction based on common units like `ns`, `ms`, `ops/s`, `mb/s`.
- **Auto-detection**: `detectFormat` uses content-based heuristics to identify benchmark-specific output formats (Go `Benchmark...`, Rust `test ... bench:`, Hyperfine, pytest-benchmark).

### External Tool Mapping

- **Go Benchmarks**: Assumes `-P` suffix in benchmark name represents a `procs` tag.
- **Rust Benchmarks**: Assumes standard `libtest` output format and always treats them as `smaller_is_better` (time-based).
- **Hyperfine**: Maps Hyperfine's JSON result structure to a specific set of metrics (`mean`, `stddev`, `min`, `max`, `median`).
- **pytest-benchmark**: Maps the `stats` object to a predefined set of metrics, including a specific mapping for `ops` to `bigger_is_better`.

### OTLP Projection

- **Benchkit OTLP Contract**: `projectBenchmarkResultFromOtlp` implements the mapping from raw OTLP metrics to the Benchkit internal model.
- **Scenario/Series Requirement**: Assumes every datapoint MUST have `benchkit.scenario` and `benchkit.series` to be projectable, with a fallback to `diagnostic` for `_monitor.*` metrics.
- **Latest-wins**: Assumes the latest datapoint by timestamp is the "result" for a single-point comparison, while also preserving samples for time-series.

## 3. Monitor & Infrastructure Assumptions (`actions/monitor/src/**`)

The monitor action, while using generic OTel Collector technology, makes several benchmark-specific configuration decisions.

- **Isolation Strategy**: Automatically filters process-level telemetry to only those processes that are descendants of the GitHub Actions runner worker PID. This assumes the user only wants the resource footprint of the benchmark task itself.
- **Reserved Metric Prefix**: `_monitor.*` is reserved for Benchkit-emitted diagnostic metrics, treated specially by reporting and projection logic.
- **Resource Stamping**: Automatically injects benchmark context (`benchkit.run_id`, `benchkit.kind`, `benchkit.source_format`) into all telemetry sidecars.

## 4. Comparison & Flow Assumptions (`packages/format/src/compare.ts`)

- **Baseline Averaging**: Assumes that the primary way to compare a run is to average multiple historical "baseline" runs.
- **Percentage-based Regressions**: Assumes a simple percentage threshold test is the default and sufficient way to detect regressions.
- **New Benchmark Exclusion**: Benchmarks present in the current run but missing from the baseline are silently excluded from comparison, assuming there is "nothing to regress against."
- **PR Reporting**: `formatComparisonMarkdown` is heavily optimized for GitHub PR comments, emphasizing regressions and using specific iconography (arrows) to indicate performance changes.

## 5. Potential Boundary Definition

The following table summarizes the likely split of ownership for Phase #180.

| Feature | Infrastructure Owned | Benchkit (Benchmark Domain) Owned |
| :--- | :--- | :--- |
| **Ingestion** | OTLP HTTP/gRPC reception | Benchkit OTLP Semantic Conventions |
| **Storage** | Git data-branch management | Run/Telemetry directory structure |
| **Processing** | Metric aggregation/averaging | Direction-aware regression testing |
| **Parsers** | Raw JSON parsing | Benchmark format translation (Go, Rust, etc.) |
| **Monitor** | Collector binary lifecycle | Runner-descendant process filtering |
| **UI** | Generic trend/line charts | Run Comparison tables & PR reports |
