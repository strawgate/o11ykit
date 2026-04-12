import { T } from "../tokens";
import type { Route } from "../router";
import { FadeIn, YamlBlock } from "../components/ui";
import { useEffect, useState, useCallback } from "preact/hooks";

/* ── Reusable doc primitives ────────────────────────────── */

function Pill(props: { color: string; children: string }) {
  return (
    <span style={{
      background: `${props.color}15`,
      color: props.color,
      padding: "2px 10px",
      borderRadius: "8px",
      fontSize: "0.68rem",
      fontFamily: T.fontMono,
      fontWeight: 600,
    }}>{props.children}</span>
  );
}

function DocCard(props: { children: preact.ComponentChildren; border?: string }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${props.border ?? "rgba(255,255,255,0.06)"}`,
      borderRadius: "12px",
      padding: "20px 24px",
      fontSize: "0.84rem",
      color: "#c9d1d9",
      lineHeight: 1.8,
    }}>
      {props.children}
    </div>
  );
}

/* ── Section definitions ────────────────────────────────── */

interface DocSection {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  color: string;
  content: () => preact.JSX.Element;
}

const sections: DocSection[] = [
  /* ─── 1. How it works ─── */
  {
    id: "how-it-works",
    icon: "⚡",
    title: "How It Works",
    subtitle: "The five-step pipeline from benchmarks to dashboards",
    color: T.blue,
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* Pipeline flow */}
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center",
          gap: "6px", fontSize: "0.75rem", fontFamily: T.fontMono, color: "#c9d1d9",
          background: "rgba(47,129,247,0.06)", border: "1px solid rgba(47,129,247,0.12)",
          borderRadius: "10px", padding: "14px 16px",
        }}>
          {[
            { label: "benchmarks", color: "#8b949e" },
            { label: "stash", color: T.green },
            { label: "bench-data", color: T.blue },
            { label: "aggregate", color: T.purple },
            { label: "compare", color: T.orange },
            { label: "dashboard", color: T.red },
          ].map((step, i) => (
            <span key={step.label}>
              {i > 0 && <span style={{ color: "#6e7681", margin: "0 2px" }}>→</span>}
              <span style={{ background: `${step.color}20`, padding: "3px 10px", borderRadius: "6px", color: step.color }}>{step.label}</span>
            </span>
          ))}
        </div>

        {/* Steps */}
        {[
          { num: "1", title: "Run benchmarks", desc: "Go, Rust, Hyperfine, pytest, or any tool that outputs JSON. The stash action auto-detects the format.", color: T.blue },
          { num: "2", title: "Stash results", desc: "actions/stash parses output into OTLP JSON and commits to your bench-data branch. Retries with rebase on conflict.", color: T.green },
          { num: "3", title: "Aggregate", desc: "A separate workflow rebuilds index.json, series/*.json, and run detail views whenever new data lands. Path filter prevents infinite loops.", color: T.purple },
          { num: "4", title: "Compare on PRs", desc: "actions/compare detects regressions against a rolling baseline (default: last 5 runs). Posts a comment and optionally fails the build.", color: T.orange },
          { num: "5", title: "Render charts", desc: "Install @benchkit/chart and mount <Dashboard />. Or use adapters to render with Recharts, ECharts, or Visx.", color: T.red },
        ].map(step => (
          <div key={step.num} style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
            <div style={{
              width: "28px", height: "28px", borderRadius: "50%",
              background: `${step.color}18`, border: `2px solid ${step.color}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.78rem", fontWeight: 700, color: step.color, flexShrink: 0,
            }}>{step.num}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#e6edf3", marginBottom: "2px" }}>{step.title}</div>
              <div style={{ fontSize: "0.78rem", color: "#8b949e", lineHeight: 1.6 }}>{step.desc}</div>
            </div>
          </div>
        ))}
      </div>
    ),
  },

  /* ─── 2. Quick start ─── */
  {
    id: "quick-start",
    icon: "🚀",
    title: "Quick Start",
    subtitle: "Copy these workflows to get running in minutes",
    color: T.green,
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <YamlBlock filename="bench.yml">{`name: Benchmarks
on:
  push:
    branches: [main]
  pull_request:

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - run: go test -bench=. -count=5 ./... | tee bench.txt

      - uses: strawgate/octo11y/actions/stash@main-dist
        with:
          results: bench.txt
          format: auto`}</YamlBlock>

        <YamlBlock filename="aggregate.yml">{`name: Aggregate
on:
  push:
    branches: [bench-data]
    paths: [data/runs/**]
  workflow_dispatch:

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - uses: strawgate/octo11y/actions/aggregate@main-dist`}</YamlBlock>

        <YamlBlock filename="compare.yml">{`# Add to your PR workflow
- uses: strawgate/octo11y/actions/compare@main-dist
  with:
    results: bench.txt
    baseline-runs: 5
    threshold: 5
    fail-on-regression: true
    comment-on-pr: true`}</YamlBlock>

        <DocCard border="rgba(63,185,80,0.2)">
          <strong style={{ color: T.green }}>💡 Tip:</strong>{" "}
          The aggregate workflow's <code style={{ fontFamily: T.fontMono, color: T.blue }}>paths: [data/runs/**]</code> filter
          prevents infinite loops — aggregate only fires when new run files arrive, not when it writes index/series files.
        </DocCard>
      </div>
    ),
  },

  /* ─── 3. Actions ─── */
  {
    id: "actions",
    icon: "🔧",
    title: "Actions",
    subtitle: "Five GitHub Actions for the full pipeline",
    color: T.orange,
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {[
          { name: "stash", icon: "📥", desc: "Parse benchmark output and commit one raw run to bench-data. Auto-detects Go, Rust, Hyperfine, pytest, benchmark-action, and OTLP formats. Retries push with rebase up to 5×.", produces: "data/runs/{run-id}/benchmark.otlp.json", inputs: "results, format, run-id, monitor-results" },
          { name: "aggregate", icon: "📊", desc: "Rebuild derived indexes, time-series, and run-detail views from all runs on bench-data. Triggered by data branch pushes with path filter.", produces: "index.json, series/*, index/refs|prs|metrics, views/*/detail.json", inputs: "data-branch, max-runs" },
          { name: "compare", icon: "🔍", desc: "Compare current results against a rolling baseline. Post a PR comment showing regressions and optionally fail the build.", produces: "PR comment + step summary", inputs: "results, baseline-runs, threshold, fail-on-regression, comment-on-pr" },
          { name: "monitor", icon: "📡", desc: "Download otelcol-contrib and collect CPU, memory, load, and process metrics. Exposes OTLP gRPC (4317) and HTTP (4318) receivers.", produces: "data/runs/{run-id}/telemetry.otlp.jsonl.gz", inputs: "scrape-interval, metric-sets, collector-version" },
          { name: "emit-metric", icon: "📤", desc: "Send a single OTLP metric to the monitor's collector. Lightweight custom values without a full SDK — perfect for shell steps.", produces: "OTLP metric → collector", inputs: "name, value, scenario, series, direction" },
        ].map(action => (
          <div key={action.name} style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px",
            padding: "18px 20px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <span style={{ fontSize: "1.3rem" }}>{action.icon}</span>
              <span style={{ fontWeight: 700, fontSize: "0.95rem", color: T.orange, fontFamily: T.fontMono }}>actions/{action.name}</span>
            </div>
            <p style={{ margin: "0 0 8px", fontSize: "0.8rem", color: "#c9d1d9", lineHeight: 1.6 }}>{action.desc}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "0.7rem" }}>
              <span style={{ color: "#6e7681" }}>Produces:</span>
              <code style={{ fontFamily: T.fontMono, color: T.blue, fontSize: "0.68rem" }}>{action.produces}</code>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "0.7rem", marginTop: "4px" }}>
              <span style={{ color: "#6e7681" }}>Key inputs:</span>
              <code style={{ fontFamily: T.fontMono, color: "#8b949e", fontSize: "0.68rem" }}>{action.inputs}</code>
            </div>
          </div>
        ))}
      </div>
    ),
  },

  /* ─── 4. Packages ─── */
  {
    id: "packages",
    icon: "📦",
    title: "Packages",
    subtitle: "Four npm packages for data, charts, and adapters",
    color: T.purple,
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {[
          {
            name: "@octo11y/core",
            version: "0.2.0",
            color: "#8b949e",
            desc: "Generic OTLP metric types, parsing, and data structures. The foundation all other packages build on.",
            exports: ["OtlpMetricsDocument", "OtlpMetric", "MetricsBatch", "buildOtlpResult"],
          },
          {
            name: "@benchkit/format",
            version: "0.2.0",
            color: T.green,
            desc: "6 benchmark parsers with auto-detection, comparison helpers, OTLP result builders, and metric naming conventions.",
            exports: ["parseBenchmarks", "compareRuns", "inferDirection", "SeriesFile", "IndexFile"],
          },
          {
            name: "@benchkit/chart",
            version: "0.2.0",
            color: T.blue,
            desc: "15+ Preact components powered by Chart.js — dashboards, trend charts, comparison bars, leaderboards, fetch helpers, regression detection.",
            exports: ["Dashboard", "TrendChart", "ComparisonBar", "Leaderboard", "fetchIndex", "detectRegressions"],
          },
          {
            name: "@benchkit/adapters",
            version: "0.1.1",
            color: T.orange,
            desc: "Library-agnostic data transforms — shared contract with adapters for Chart.js, Recharts, ECharts, and Visx.",
            exports: ["recharts", "echarts", "visx", "chartjs", "shared-contract", "regression"],
          },
        ].map(pkg => (
          <div key={pkg.name} style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px",
            padding: "18px 20px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px", flexWrap: "wrap" }}>
              <code style={{ fontWeight: 700, fontSize: "0.92rem", color: pkg.color, fontFamily: T.fontMono }}>{pkg.name}</code>
              <span style={{ fontSize: "0.65rem", color: "#6e7681", background: "rgba(255,255,255,0.05)", padding: "1px 8px", borderRadius: "6px" }}>v{pkg.version}</span>
            </div>
            <p style={{ margin: "0 0 10px", fontSize: "0.8rem", color: "#c9d1d9", lineHeight: 1.6 }}>{pkg.desc}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {pkg.exports.map(e => (
                <Pill key={e} color={pkg.color}>{e}</Pill>
              ))}
            </div>
          </div>
        ))}
      </div>
    ),
  },

  /* ─── 5. Data architecture ─── */
  {
    id: "data",
    icon: "🏗️",
    title: "Data Architecture",
    subtitle: "How data flows from benchmarks to charts",
    color: "#79c0ff",
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <DocCard>
          <h4 style={{ margin: "0 0 8px", color: "#79c0ff", fontSize: "0.88rem" }}>Producer / Aggregate Split</h4>
          <p style={{ margin: 0, fontSize: "0.82rem" }}>
            The <strong>producer</strong> (bench.yml) runs benchmarks and commits only raw run files.
            The <strong>aggregate</strong> workflow triggers on <code style={{ fontFamily: T.fontMono, color: T.blue }}>push → bench-data/data/runs/**</code> and
            rebuilds all derived views. Path filter prevents infinite loops.
          </p>
        </DocCard>

        <DocCard>
          <h4 style={{ margin: "0 0 8px", color: "#79c0ff", fontSize: "0.88rem" }}>Branch Layout</h4>
          <pre style={{
            margin: 0, fontFamily: T.fontMono, fontSize: "0.73rem", lineHeight: 1.7, color: "#c9d1d9", whiteSpace: "pre-wrap",
          }}>{`bench-data/data/
├── index.json                 ← run index
├── index/
│   ├── refs.json              ← per-branch index
│   ├── prs.json               ← per-PR index
│   └── metrics.json           ← metric summary
├── runs/{id}/
│   ├── benchmark.otlp.json    ← raw benchmark OTLP
│   └── telemetry.otlp.jsonl.gz← monitor sidecar
├── series/{metric}.json       ← time-series per metric
├── views/runs/{id}/
│   └── detail.json            ← pre-built run view`}</pre>
        </DocCard>

        <DocCard>
          <h4 style={{ margin: "0 0 8px", color: "#79c0ff", fontSize: "0.88rem" }}>Collision-proof Run IDs</h4>
          <p style={{ margin: 0, fontSize: "0.82rem" }}>
            Default: <code style={{ fontFamily: T.fontMono, color: T.green }}>{"${RUN_ID}-${ATTEMPT}--${JOB}"}</code>.
            Matrix builds must include the matrix key in a custom <code style={{ fontFamily: T.fontMono, color: T.green }}>run-id</code> input.
          </p>
        </DocCard>

        {/* Schema table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                <th style={{ textAlign: "left", padding: "8px 10px", color: "#6e7681", fontWeight: 600 }}>Schema</th>
                <th style={{ textAlign: "left", padding: "8px 10px", color: "#6e7681", fontWeight: 600 }}>File</th>
                <th style={{ textAlign: "left", padding: "8px 10px", color: "#6e7681", fontWeight: 600 }}>Writer</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["index.schema.json", "data/index.json", "aggregate"],
                ["series.schema.json", "data/series/{metric}.json", "aggregate"],
                ["index-refs.schema.json", "data/index/refs.json", "aggregate"],
                ["index-prs.schema.json", "data/index/prs.json", "aggregate"],
                ["index-metrics.schema.json", "data/index/metrics.json", "aggregate"],
                ["view-run-detail.schema.json", "views/runs/{id}/detail.json", "aggregate"],
                ["comparison-result.schema.json", "compare() output", "@benchkit/format"],
              ].map(([schema, file, writer]) => (
                <tr key={schema} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", fontFamily: T.fontMono, color: "#79c0ff", fontSize: "0.72rem" }}>{schema}</td>
                  <td style={{ padding: "6px 10px", fontFamily: T.fontMono, color: "#c9d1d9", fontSize: "0.72rem" }}>{file}</td>
                  <td style={{ padding: "6px 10px", color: "#8b949e" }}>{writer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  },

  /* ─── 6. Roadmap ─── */
  {
    id: "roadmap",
    icon: "🗺️",
    title: "Roadmap",
    subtitle: "Where we are and where we're going",
    color: "#ffa657",
    content: () => (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <DocCard border="rgba(63,185,80,0.2)">
          <strong style={{ color: T.green, fontSize: "0.85rem" }}>Vision:</strong>{" "}
          Octo11y is the simplest way to publish, compare, and investigate benchmark results from
          GitHub workflows. No servers, no databases — just Actions and static hosting.
        </DocCard>

        {[
          { phase: "1", status: "✅", title: "OTLP end-to-end", desc: "All parsers, MetricsBatch, 5 actions, chart surfaces, adapters, release automation.", done: true },
          { phase: "2", status: "🔄", title: "Docs & clarity", desc: "Documentation hub, getting-started, adapter reference, product surface strategy.", done: false },
          { phase: "3", status: "📋", title: "Workflow ergonomics", desc: "Starter kit, JSON/Prometheus collectors, CI recipes for common patterns.", done: false },
          { phase: "4", status: "📋", title: "Dashboard evolution", desc: "CompetitiveDashboard, export/embed, richer visualizations.", done: false },
          { phase: "5", status: "📋", title: "MetricsKit split", desc: "Generic OTLP platform layer + benchmark domain separation.", done: false },
          { phase: "6", status: "📋", title: "Advanced query", desc: "DuckDB-Wasm client-side analytics (optional, experimental).", done: false },
        ].map(p => (
          <div key={p.phase} style={{
            display: "flex", gap: "12px", alignItems: "flex-start",
            background: p.done ? "rgba(63,185,80,0.04)" : "rgba(255,255,255,0.02)",
            border: `1px solid ${p.done ? "rgba(63,185,80,0.15)" : "rgba(255,255,255,0.05)"}`,
            borderRadius: "10px", padding: "14px 16px",
          }}>
            <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>{p.status}</span>
            <div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "2px" }}>
                <span style={{ fontWeight: 700, fontSize: "0.78rem", color: "#ffa657" }}>Phase {p.phase}</span>
                <span style={{ fontWeight: 600, fontSize: "0.82rem", color: "#e6edf3" }}>{p.title}</span>
              </div>
              <div style={{ fontSize: "0.75rem", color: "#8b949e", lineHeight: 1.6 }}>{p.desc}</div>
            </div>
          </div>
        ))}
      </div>
    ),
  },
];

/* ── Main page component ────────────────────────────────── */

export function DocsPage(_props: { go: (r: Route) => void }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const scrollTo = useCallback((id: string) => {
    if (!openIds.has(id)) {
      setOpenIds(prev => new Set(prev).add(id));
    }
    setTimeout(() => {
      document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, [openIds]);

  useEffect(() => {
    const html = document.documentElement;
    html.style.scrollBehavior = "smooth";
    return () => { html.style.scrollBehavior = ""; };
  }, []);

  return (
    <div>
      <style>{`
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      `}</style>

      {/* ── Hero ── */}
      <section style={{
        minHeight: "40vh",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "100px 24px 40px",
        background: "linear-gradient(180deg, #070e1f 0%, #0d1830 60%, #111d2e 100%)",
        color: T.textOnDark, textAlign: "center" as const,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", inset: "0", pointerEvents: "none", backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        <FadeIn>
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ fontSize: "3.5rem", marginBottom: "16px", animation: "float 4s ease-in-out infinite" }}>📚</div>
            <h1 style={{ margin: 0, fontSize: "2.2rem", fontWeight: 800, letterSpacing: "-0.03em" }}>Documentation</h1>
            <p style={{ margin: "10px auto 0", maxWidth: "480px", fontSize: "0.92rem", color: "#8b949e", lineHeight: 1.7 }}>
              From first benchmark to custom dashboards.
            </p>
          </div>
        </FadeIn>
      </section>

      {/* ── Quick nav bar ── */}
      <section style={{
        background: "#111d2e",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        position: "sticky", top: "56px", zIndex: 90,
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      }}>
        <div style={{
          maxWidth: "960px", margin: "0 auto", padding: "0 16px",
          display: "flex", gap: "2px", overflowX: "auto",
        }}>
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              style={{
                border: "none",
                background: openIds.has(s.id) ? `${s.color}15` : "transparent",
                color: openIds.has(s.id) ? s.color : "#6e7681",
                padding: "10px 12px",
                cursor: "pointer",
                fontSize: "0.72rem",
                fontWeight: 600,
                fontFamily: T.font,
                whiteSpace: "nowrap",
                borderBottom: openIds.has(s.id) ? `2px solid ${s.color}` : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              {s.icon} {s.title}
            </button>
          ))}
        </div>
      </section>

      {/* ── Content ── */}
      <div style={{
        background: "linear-gradient(180deg, #111d2e 0%, #0d1830 100%)",
        minHeight: "50vh",
        padding: "32px 16px 100px",
      }}>
        <div style={{ maxWidth: "820px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "12px" }}>
          {sections.map(s => {
            const open = openIds.has(s.id);
            return (
              <div key={s.id} id={`doc-${s.id}`} style={{ scrollMarginTop: "120px" }}>
                <button
                  onClick={() => toggle(s.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: "12px",
                    background: "rgba(255,255,255,0.025)",
                    border: `1px solid ${open ? `${s.color}35` : "rgba(255,255,255,0.06)"}`,
                    borderRadius: open ? "12px 12px 0 0" : "12px",
                    padding: "16px 20px", cursor: "pointer",
                    color: T.textOnDark, fontFamily: T.font,
                    textAlign: "left" as const, transition: "border-color 0.15s",
                  }}
                >
                  <span style={{ fontSize: "1.3rem" }}>{s.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{s.title}</div>
                    <div style={{ fontSize: "0.72rem", color: "#6e7681", marginTop: "1px" }}>{s.subtitle}</div>
                  </div>
                  <span style={{
                    fontSize: "0.78rem", color: s.color,
                    transition: "transform 0.2s",
                    transform: open ? "rotate(180deg)" : "rotate(0deg)",
                  }}>▼</span>
                </button>
                {open && (
                  <div style={{
                    background: "rgba(255,255,255,0.015)",
                    border: `1px solid ${s.color}35`,
                    borderTop: "none",
                    borderRadius: "0 0 12px 12px",
                    padding: "20px",
                  }}>
                    <FadeIn>{s.content()}</FadeIn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
