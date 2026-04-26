# o11ylogsdb dev-docs

Internal-only design notes. Public README: [`../README.md`](../README.md).
Execution plan: [`../PLAN.md`](../PLAN.md).

| Doc | Purpose |
|---|---|
| [`findings.md`](./findings.md) | What we measured. Validated and refuted assumptions, per-corpus B/log numbers, entropy floors. |
| [`techniques.md`](./techniques.md) | What we ship and why. Codec stack, index choices, query path, the patterns we adopted from production logs systems. |
| [`drain-prototype.md`](./drain-prototype.md) | The M2 Rust prototype: what it does, where it lives, what's left to graduate. |

These docs cover the design rationale that doesn't fit in PLAN.md. Numbers
and decisions are grounded in benchmarks under `../bench/`. The bench
modules are reproducible — `npm run bench --workspace o11ylogsdb` from the
repo root re-runs them.
