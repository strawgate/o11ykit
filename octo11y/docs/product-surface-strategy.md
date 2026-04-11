# Product Surface Strategy

This document defines how the public-facing benchkit surfaces should split their responsibilities.

## Goal

Stop using one site to explain every concept, showcase every capability, and host every experiment.

We want three distinct surfaces:

1. `octo11y` main site: explain the metric pipeline and show live, understandable metrics emitted from GitHub Actions.
2. `benchkit-demo`: go deep on benchmark extraction, workflow telemetry, regressions, and interactive chart walkthroughs.
3. `benchkit-playground`: host playful or unusual metric demos that prove the pipeline can turn arbitrary public data into time series.

## Surface roles

### 1. Main site: Octo11y living guide

The main repo site should stop presenting itself as a benchmark-first dashboard. It should introduce the general idea behind emitting OTLP metrics from GitHub Actions and help users understand what they can build with the stack.

Primary audience:

- users who do not yet know why they would emit metrics from Actions
- users deciding whether the project is a generic metrics tool, a benchmark tool, or both
- users who want a quick proof that the end-to-end loop actually works

Core jobs:

- explain the pipeline: emit metric -> store artifacts -> aggregate views -> visualize trends
- introduce the core actions and packages at a concept level
- prove that the project works with live metrics from this repository
- route deeper users to the right next destination

Recommended live examples:

- open issues count
- open pull requests count
- issues closed in the last 7 days
- pull requests merged in the last 7 days
- workflow duration or run count metrics

This surface should feel like a living guide, not a benchmark gallery.

Suggested sections:

1. Hero: what Octo11y is and why emitting metrics from Actions is useful.
2. How it works: a compact pipeline walkthrough.
3. Live repo metrics: small cards and trend charts for issue, PR, and workflow metrics.
4. Recipes: a few short examples of turning API output or script output into metrics.
5. Calls to action: Benchkit Demo for deep benchmarking, Playground for experiments.

### 2. Benchkit Demo: deep benchmark and telemetry walkthrough

Benchkit Demo should focus on performance and observability depth. This is where users should experience the value of the benchmark-specific tooling and the monitor pipeline.

Primary audience:

- users who want to benchmark code and workflows in CI
- users who care about regressions, comparisons, telemetry, and drilldown views
- users evaluating whether benchkit can replace ad hoc benchmark dashboards

Core jobs:

- show extraction from real benchmark formats such as Go, Python, Rust, Hyperfine, and OTLP JSON
- show runner/process telemetry from `actions/monitor`
- connect raw output to parsed metrics to charts and comparisons
- make regression analysis and scenario comparisons feel concrete

Suggested walkthrough sections:

1. Start from log output or benchmark files.
2. Show parsed metrics and normalized OTLP shape.
3. Show trend, comparison-line, and comparison-bar views.
4. Show CPU, memory, disk, process, and related telemetry from monitor.
5. Show PR comparison and baseline regression workflows.
6. Show embedding and alternate chart-library renderers.

This surface should be interactive and narrative-heavy. It should answer: what can I do once I care deeply about performance data?

### 3. Playground: fun metrics and public-data experiments

The playground should remain fast-moving and lightweight. It exists to demonstrate flexibility and delight, not to carry the main product explanation.

Primary audience:

- users who learn best from playful examples
- maintainers testing new workflow recipes or dashboards
- contributors experimenting with new data sources without touching the stable showcase

Core jobs:

- prove that the same workflow can power non-benchmark data
- show how arbitrary public APIs or scrapers can become time series in Actions
- make experimentation cheap and safe

Candidate playground demos:

- US average gas price by state or national average
- weather, air quality, or pollen metrics by city
- GitHub stars, issue velocity, or release cadence for selected repos
- Hacker News or package download trends
- hotel or transit availability metrics where the data source is stable and easy to automate

The litmus test for playground content is simple: can a GitHub Action fetch it reliably, emit it as metrics, and produce something surprising or useful?

## Information architecture

### Main site navigation

- Overview
- How it works
- Live metrics
- Recipes
- Benchkit Demo
- Playground

### Benchkit Demo navigation

- Benchmark formats
- Monitor telemetry
- Regressions and comparisons
- Chart views
- Embeds and adapters
- Try it yourself

### Playground navigation

- Featured experiments
- Data source recipes
- Build your own

## Content boundaries

Keep these boundaries hard:

- Main site should not try to be the full benchmark explorer.
- Benchkit Demo should not spend most of its time re-explaining the generic metrics pitch.
- Playground should not become the stable documentation site.

## Initial implementation plan

### Phase A: reposition the main site as Octo11y

- replace benchmark-first hero copy with Octo11y metrics-pipeline copy
- add a compact pipeline walkthrough and action/package overview
- add at least one live metrics recipe using repository issue and PR counts
- add calls to action for Benchkit Demo and Playground

### Phase B: turn Benchkit Demo into a narrative deep dive

- create a walkthrough-oriented demo flow instead of a single dogfood dashboard
- highlight benchmark extraction and monitor telemetry side by side
- show raw output -> parsed metric -> chart transitions
- use the adapter surfaces to render multiple chart-library experiences where helpful

### Phase C: make Playground intentionally playful

- define a small set of stable public-data demos
- document how each demo fetches data in Actions and emits metrics
- keep the repo-local footprint low and iteration speed high

## Acceptance criteria

- the main site clearly presents Octo11y as a generic Actions-to-metrics platform
- Benchkit Demo clearly presents deep benchmark and telemetry workflows
- Playground clearly presents fun or experimental metric recipes
- all three surfaces link to one another with explicit calls to action
- at least one live main-site demo uses repository activity metrics instead of benchmark metrics