# Octo11y Architecture Review (Historical)

This file began as a pre-release architecture review and release plan.

Large parts of the original document became stale once the following work landed
on `main`:

- release automation (`#38`)
- the PR comparison foundation (`#46`, `#47`, `#48`, `#50`)
- the first emitted set of aggregate view artifacts (`#91`, `#92`)

Because of that, this file should now be treated as **historical context**, not
as the current repository status or roadmap.

## What is still useful here

The original review got several long-lived principles right:

- benchkit should stay zero-infrastructure
- collection, aggregation, and visualization should remain separate concerns
- PR-native benchmarking is a first-class workflow
- runs and scenarios should become the primary UX surfaces
- OTLP is the long-term raw-format direction

## Current source-of-truth docs

For current repository truth, use these documents instead:

1. [`../../README.md`](../../README.md) — current product overview and shipped workflows
2. [`../vision-and-roadmap.md`](../vision-and-roadmap.md) — current open roadmap and backlog framing
3. [`../internal/agent-handoff.md`](../internal/agent-handoff.md) — current handoff and status notes for future agents
4. [`../otlp-aggregation-architecture.md`](../otlp-aggregation-architecture.md) — OTLP-first architecture direction
5. [`../otlp-semantic-conventions.md`](../otlp-semantic-conventions.md) — semantic contract for OTLP work
6. [`../artifact-layout.md`](../artifact-layout.md) — aggregate artifact layout already emitted on `main`

## Monitor note

The repository docs intentionally still describe the collector-backed monitor behavior that exists on `main` today.

Keep `README.md`, `actions/monitor/README.md`, workflow examples, and OTLP storage notes aligned with that implementation.
