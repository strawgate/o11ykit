# @benchkit/dashboard

Private Preact app used for the o11ykit "Experiences" pages on GitHub Pages. This is **not** a library or template.

## Role

`packages/dashboard` exists to:

- **Introduce** the Octo11y metrics pipeline with a living-guide landing page and live repository activity metrics.
- **Route** users to the right surface: benchmark deep dive versus playground experimentation.
- **Dogfood** `@benchkit/chart` against real benchmark data via the in-app Benchkit deep-dive route.
- **Deploy** a stable public demo via the [GitHub Pages workflow](../../.github/workflows/pages.yml) on published releases.

## Stable demo vs playground

Benchkit uses a two-lane model:

- **Stable demo (this repo)**: `packages/dashboard` deploys from release tags so the public site reflects published packages and avoids accidental regressions from in-flight `main` edits.
- **Playground (separate repo recommended)**: iterate quickly against `main` and experimental workflows without risking the stable demo or touching production `bench-data` automation.

This split is intentional: it keeps public docs and the showcase URL reliable while still giving maintainers a fast sandbox for feature and workflow experiments.

It is marked `"private": true` in `package.json` and will never be published to npm.

## Building on benchkit

If you want to build your own dashboard, **start from `@benchkit/chart` directly** — do not fork this app. The chart package exports three ready-made surfaces:

| Surface | Use case |
|---|---|
| `Dashboard` | Metric-first overview with trend charts, comparisons, regressions, and monitor panels. |
| `RunDashboard` | PR- or run-oriented entry point with run selectors and baseline comparison. |
| `RunDetail` | Deep-dive page for a single run's metrics and diagnostics. |

See [`packages/chart/README.md`](../chart/README.md) for full prop tables and [`docs/getting-started.md`](../../docs/getting-started.md) for a step-by-step setup guide.

## Local development

```bash
# from the repo root
npm ci
npm run build            # build format + chart first
npm run dev --workspace=packages/dashboard
```

The dev server starts at `http://localhost:5173/benchkit/` and fetches live data from the `bench-data` branch.

## How it works

[`src/main.tsx`](src/main.tsx) now includes two primary routes in one app:

- `#home` (default): Octo11y living guide with live GitHub repository activity metrics and calls to action
- `#benchkit`: full `@benchkit/chart` benchmark dashboard deep dive

The home route emphasizes the generic Actions-to-metrics story. The Benchkit route preserves deep benchmark exploration.

The Benchkit route renders a `<Dashboard>` component pointed at the configured data source repo (defaults to `strawgate/o11ykit-playground`):

```tsx
<Dashboard
  source={{ owner: "strawgate", repo: "o11ykit-playground" }}
  seriesNameFormatter={(name) => name.replace(/^Benchmark/, "")}
  commitHref={(sha) => `https://github.com/strawgate/o11ykit-playground/commit/${sha}`}
  regressionThreshold={10}
  regressionWindow={5}
/>
```

Vite builds a static bundle into `dist/`, which the Pages workflow uploads as an artifact and deploys.
