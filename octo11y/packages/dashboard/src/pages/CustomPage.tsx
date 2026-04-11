import { T } from "../tokens";
import type { Route } from "../router";
import { FadeIn, YamlBlock } from "../components/ui";
import { useEffect } from "preact/hooks";

export function CustomPage(_props: { go: (r: Route) => void }) {
  useEffect(() => {
    const html = document.documentElement;
    html.style.scrollSnapType = "y mandatory";
    html.style.scrollPaddingTop = "60px";
    html.style.scrollBehavior = "smooth";
    return () => {
      html.style.scrollSnapType = "";
      html.style.scrollPaddingTop = "";
      html.style.scrollBehavior = "";
    };
  }, []);

  const page: Record<string, string> = {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "100px 24px",
    position: "relative",
    overflow: "hidden",
  };

  const chapterTag = (color: string): Record<string, string> => ({
    fontSize: "0.68rem",
    fontWeight: "700",
    color,
    textTransform: "uppercase",
    letterSpacing: "0.18em",
    marginBottom: "16px",
  });

  return (
    <div>
      <style>{`
        .custom-snap {
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-10px); }
        }
        @keyframes rotateOrbit {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes fillBar {
          0%   { width: 0; }
          100% { width: var(--bar-w); }
        }
      `}</style>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 1 — The two paths
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #070e1f 0%, #0c1a33 40%, #081428 100%)",
        color: T.textOnDark,
      }}>
        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "680px", position: "relative", zIndex: "1" }}>
            <div style={{ fontSize: "4.5rem", marginBottom: "28px", animation: "float 4s ease-in-out infinite" }}>🔌</div>
            <div style={chapterTag("#58a6ff")}>Two Ways to Chart</div>
            <h2 style={{ margin: 0, fontSize: "2.2rem", fontWeight: 800, lineHeight: 1.15, letterSpacing: "-0.03em" }}>
              Batteries included,{" "}
              <span style={{ color: T.blue }}>or bring your own.</span>
            </h2>
            <p style={{ margin: "20px 0 0", fontSize: "1rem", color: "#8b949e", lineHeight: 1.7, maxWidth: "560px", marginLeft: "auto", marginRight: "auto" }}>
              <code style={{ color: T.blue, fontFamily: T.fontMono, fontSize: "0.88rem" }}>@benchkit/chart</code> ships
              15+ ready-made Preact components powered by Chart.js. Want a different library?
              Grab <code style={{ color: T.green, fontFamily: T.fontMono, fontSize: "0.88rem" }}>@benchkit/adapters</code> and
              use Recharts, ECharts, or Visx with the same data.
            </p>

            {/* Two path cards */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", marginTop: "40px", justifyContent: "center" }}>
              <div style={{
                background: "rgba(47,129,247,0.08)",
                border: "1px solid rgba(47,129,247,0.25)",
                borderRadius: "14px",
                padding: "24px 28px",
                flex: "1 1 240px",
                maxWidth: "300px",
                textAlign: "left" as const,
              }}>
                <div style={{ fontSize: "1.8rem", marginBottom: "10px" }}>📦</div>
                <div style={{ fontWeight: 700, fontSize: "0.95rem", color: T.blue, marginBottom: "6px" }}>Path A — Drop-in</div>
                <div style={{ fontSize: "0.78rem", color: "#c9d1d9", lineHeight: 1.6 }}>
                  Install <code style={{ fontFamily: T.fontMono }}>@benchkit/chart</code>, mount{" "}
                  <code style={{ fontFamily: T.fontMono }}>&lt;Dashboard /&gt;</code>, done.
                  Chart.js under the hood. Zero config.
                </div>
              </div>
              <div style={{
                background: "rgba(63,185,80,0.08)",
                border: "1px solid rgba(63,185,80,0.25)",
                borderRadius: "14px",
                padding: "24px 28px",
                flex: "1 1 240px",
                maxWidth: "300px",
                textAlign: "left" as const,
              }}>
                <div style={{ fontSize: "1.8rem", marginBottom: "10px" }}>🎨</div>
                <div style={{ fontWeight: 700, fontSize: "0.95rem", color: T.green, marginBottom: "6px" }}>Path B — Custom</div>
                <div style={{ fontSize: "0.78rem", color: "#c9d1d9", lineHeight: 1.6 }}>
                  Use <code style={{ fontFamily: T.fontMono }}>@benchkit/adapters</code> to
                  transform OTLP data into shapes Recharts, ECharts, or Visx expect.
                  You own the rendering.
                </div>
              </div>
            </div>
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 2 — Path A: What ships in @benchkit/chart
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #081428 0%, #0d1b2a 50%, #111d2e 100%)",
        color: T.textOnDark,
      }}>
        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "800px" }}>
            <div style={chapterTag("#58a6ff")}>Path A — @benchkit/chart</div>
            <h2 style={{ margin: "0 0 8px", fontSize: "1.8rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              15 components, one import
            </h2>
            <p style={{ margin: "0 0 32px", fontSize: "0.88rem", color: "#8b949e", lineHeight: 1.7 }}>
              Preact components backed by Chart.js. Fetch data, render, detect regressions — all built in.
            </p>

            {/* Component grid */}
            {[
              { label: "Full Surfaces", color: T.blue, items: [
                { icon: "📋", name: "Dashboard", desc: "Metric-first overview" },
                { icon: "🏃", name: "RunDashboard", desc: "PR/run entry point" },
                { icon: "🔍", name: "RunDetail", desc: "Single-run deep dive" },
              ]},
              { label: "Charts", color: T.green, items: [
                { icon: "📈", name: "TrendChart", desc: "Time-series + regressions" },
                { icon: "🔀", name: "ComparisonChart", desc: "Baseline vs current" },
                { icon: "📊", name: "ComparisonBar", desc: "Ranked bar chart" },
                { icon: "📉", name: "SampleChart", desc: "Intra-run profiling" },
                { icon: "🏆", name: "Leaderboard", desc: "Ranked table + deltas" },
              ]},
              { label: "UI & Filters", color: T.purple, items: [
                { icon: "🏷️", name: "TagFilter", desc: "Series tag pills" },
                { icon: "📅", name: "DateRangeFilter", desc: "Time-window picker" },
                { icon: "🔄", name: "RunSelector", desc: "Run comparison picker" },
                { icon: "📡", name: "MonitorSection", desc: "Runner telemetry" },
                { icon: "✅", name: "VerdictBanner", desc: "Regression verdict" },
                { icon: "📋", name: "RunTable", desc: "Paginated run list" },
                { icon: "🔧", name: "MetricCard", desc: "Sparkline + value" },
              ]},
            ].map(group => (
              <div key={group.label} style={{ marginBottom: "24px" }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: group.color, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "10px" }}>
                  {group.label}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
                  {group.items.map(c => (
                    <div key={c.name} style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: "10px",
                      padding: "12px 16px",
                      minWidth: "120px",
                      flex: "0 1 160px",
                      textAlign: "center" as const,
                    }}>
                      <div style={{ fontSize: "1.4rem", marginBottom: "4px" }}>{c.icon}</div>
                      <div style={{ fontSize: "0.76rem", fontWeight: 700, color: "#e6edf3" }}>{c.name}</div>
                      <div style={{ fontSize: "0.65rem", color: "#8b949e", marginTop: "2px" }}>{c.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 3 — Path B: Adapters
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #111d2e 0%, #0f1b2d 50%, #0c1729 100%)",
        color: T.textOnDark,
        padding: "100px 16px",
      }}>
        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "800px", marginBottom: "36px" }}>
            <div style={chapterTag("#7ee787")}>Path B — @benchkit/adapters</div>
            <h2 style={{ margin: "0 0 8px", fontSize: "1.8rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              Four libraries. One API surface.
            </h2>
            <p style={{ margin: "0 0 8px", fontSize: "0.88rem", color: "#8b949e", lineHeight: 1.7 }}>
              Each adapter exposes 3 chart intents — trend, comparison line, and comparison bar.
              Same options, same defaults. Switching libraries is a one-line import change.
            </p>
            <p style={{ margin: "0", fontSize: "0.78rem", color: "#6e7681" }}>
              All four are stable at v0.1.1 on npm. Pure transforms with zero framework dependencies.
            </p>
          </div>
        </FadeIn>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "16px", maxWidth: "1000px", width: "100%" }}>
          {[
            {
              name: "Chart.js",
              color: "#ff6384",
              icon: "📊",
              pkg: "@benchkit/adapters/chartjs",
              desc: "Default engine in @benchkit/chart. Config objects for Line, Bar controllers.",
              fns: ["trendChartDataset", "comparisonBarData"],
            },
            {
              name: "Recharts",
              color: T.blue,
              icon: "📈",
              pkg: "@benchkit/adapters/recharts",
              desc: "Flat data arrays with predictable keys. Drop into <LineChart> or <BarChart>.",
              fns: ["trendLineData", "comparisonLineData", "comparisonBarData"],
            },
            {
              name: "ECharts",
              color: T.green,
              icon: "🌐",
              pkg: "@benchkit/adapters/echarts",
              desc: "Full option objects — tooltip, legend, axes, series. chart.setOption() and go.",
              fns: ["trendLineOption", "comparisonLineOption", "comparisonBarOption"],
            },
            {
              name: "Visx",
              color: T.purple,
              icon: "🎨",
              pkg: "@benchkit/adapters/visx",
              desc: "D3-scale-ready series with Date x-values and accessor helpers. Low-level control.",
              fns: ["trendLineSeries", "comparisonLineSeries", "comparisonBarSeries"],
            },
          ].map(lib => (
            <FadeIn key={lib.name}>
              <div style={{
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${lib.color}25`,
                borderRadius: "14px",
                padding: "24px",
                height: "100%",
                position: "relative",
                overflow: "hidden",
              }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2px", background: `linear-gradient(90deg, transparent, ${lib.color}, transparent)` }} />
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                  <span style={{ fontSize: "1.6rem" }}>{lib.icon}</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "1rem", color: "#e6edf3" }}>{lib.name}</div>
                    <code style={{ fontSize: "0.62rem", fontFamily: T.fontMono, color: "#6e7681" }}>{lib.pkg}</code>
                  </div>
                </div>
                <p style={{ margin: "0 0 14px", fontSize: "0.78rem", color: "#8b949e", lineHeight: 1.6 }}>{lib.desc}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                  {lib.fns.map(fn => (
                    <span key={fn} style={{
                      background: `${lib.color}12`,
                      color: lib.color,
                      padding: "2px 8px",
                      borderRadius: "8px",
                      fontSize: "0.65rem",
                      fontFamily: T.fontMono,
                      fontWeight: 600,
                    }}>{fn}</span>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 4 — Shared contract + coverage
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0c1729 0%, #0a1220 50%, #0d1524 100%)",
        color: T.textOnDark,
      }}>
        <FadeIn>
          <div style={{ maxWidth: "720px", width: "100%" }}>
            <div style={{ textAlign: "center", marginBottom: "36px" }}>
              <div style={chapterTag("#ffa657")}>The Shared Contract</div>
              <h2 style={{ margin: "0 0 8px", fontSize: "1.8rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
                Same options everywhere
              </h2>
              <p style={{ margin: 0, fontSize: "0.88rem", color: "#8b949e", lineHeight: 1.7 }}>
                Every adapter accepts the same configuration. Switch libraries without
                rewriting your data pipeline.
              </p>
            </div>

            {/* Contract options */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px", marginBottom: "36px" }}>
              {[
                { name: "metricName", type: "string", desc: "Which metric to chart" },
                { name: "maxPoints", type: "100", desc: "Limit data density" },
                { name: "tags", type: "Record", desc: "Filter by series tags" },
                { name: "palette", type: "string[]", desc: "Color scheme" },
                { name: "xFormatter", type: "fn", desc: "X-axis labels" },
                { name: "yFormatter", type: "fn", desc: "Y-axis labels" },
              ].map(opt => (
                <div key={opt.name} style={{
                  background: "rgba(255,166,87,0.06)",
                  border: "1px solid rgba(255,166,87,0.15)",
                  borderRadius: "10px",
                  padding: "12px 14px",
                }}>
                  <code style={{ fontFamily: T.fontMono, fontWeight: 700, fontSize: "0.78rem", color: "#ffa657" }}>{opt.name}</code>
                  <span style={{ fontSize: "0.65rem", color: "#6e7681", marginLeft: "6px" }}>{opt.type}</span>
                  <div style={{ fontSize: "0.7rem", color: "#8b949e", marginTop: "4px" }}>{opt.desc}</div>
                </div>
              ))}
            </div>

            {/* Coverage assessment */}
            <div style={{ textAlign: "center", marginBottom: "28px" }}>
              <div style={chapterTag("#79c0ff")}>Use-case coverage</div>
              <h3 style={{ margin: "0 0 20px", fontSize: "1.3rem", fontWeight: 700 }}>What you can build today</h3>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { label: "Trend visualization", pct: 100, note: "Time-series for any metric" },
                { label: "Regression detection", pct: 100, note: "Window-based with highlighting" },
                { label: "PR baseline comparison", pct: 100, note: "Before/after overlays" },
                { label: "Leaderboard / ranking", pct: 100, note: "Latest-value rankings" },
                { label: "Multi-tag filtering", pct: 100, note: "OS, arch, compiler, dataset" },
                { label: "Custom theming", pct: 80, note: "Data-layer only; styling is yours" },
                { label: "Advanced analytics", pct: 0, note: "Moving avg, percentiles — Phase 6" },
              ].map(row => (
                <div key={row.label} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: "10px",
                  padding: "12px 16px",
                }}>
                  <div style={{ flex: "0 0 160px", fontSize: "0.78rem", fontWeight: 600, color: "#e6edf3" }}>
                    {row.label}
                  </div>
                  <div style={{ flex: 1, height: "6px", background: "rgba(255,255,255,0.06)", borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      borderRadius: "3px",
                      background: row.pct === 100 ? T.green : row.pct >= 80 ? T.blue : row.pct > 0 ? T.orange : "rgba(255,255,255,0.08)",
                      width: `${row.pct}%`,
                      transition: "width 1s ease",
                    }} />
                  </div>
                  <div style={{ flex: "0 0 36px", fontSize: "0.72rem", fontWeight: 700, color: row.pct === 100 ? T.green : row.pct >= 80 ? T.blue : row.pct > 0 ? T.orange : "#6e7681", textAlign: "right" as const }}>
                    {row.pct}%
                  </div>
                  <div style={{ flex: "0 0 200px", fontSize: "0.68rem", color: "#6e7681" }}>
                    {row.note}
                  </div>
                </div>
              ))}
            </div>

            <div style={{
              textAlign: "center",
              marginTop: "24px",
              fontSize: "0.82rem",
              color: "#8b949e",
            }}>
              Overall: adapters cover <strong style={{ color: T.green, fontSize: "1.1rem" }}>~92%</strong> of typical benchmark charting needs
            </div>
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 5 — Supported input formats
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1524 0%, #0e1829 50%, #08101e 100%)",
        color: T.textOnDark,
      }}>
        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "700px", marginBottom: "36px" }}>
            <div style={chapterTag("#d2a8ff")}>Input Formats</div>
            <h2 style={{ margin: "0 0 8px", fontSize: "1.8rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              Seven parsers, one output
            </h2>
            <p style={{ margin: 0, fontSize: "0.88rem", color: "#8b949e", lineHeight: 1.7 }}>
              <code style={{ color: T.purple, fontFamily: T.fontMono, fontSize: "0.82rem" }}>@benchkit/format</code> auto-detects
              your benchmark output and normalizes everything to OTLP JSON.
              The adapters and chart components consume that single format.
            </p>
          </div>
        </FadeIn>

        <FadeIn>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px", maxWidth: "780px", width: "100%" }}>
            {[
              { icon: "🐹", name: "Go", fn: "parseGoBench", input: "testing.B text" },
              { icon: "🦀", name: "Rust", fn: "parseRustBench", input: "cargo bench text" },
              { icon: "⏱️", name: "Hyperfine", fn: "parseHyperfine", input: "JSON results" },
              { icon: "🐍", name: "pytest", fn: "parsePytestBenchmark", input: "JSON stats" },
              { icon: "📦", name: "benchmark-action", fn: "parseBenchmarkAction", input: "name+value JSON" },
              { icon: "📡", name: "OTLP", fn: "parseOtlp", input: "resourceMetrics JSON" },
            ].map(f => (
              <div key={f.name} style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: "12px",
                padding: "16px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                  <span style={{ fontSize: "1.3rem" }}>{f.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>{f.name}</span>
                </div>
                <div style={{ fontSize: "0.68rem", color: "#6e7681", marginBottom: "6px" }}>{f.input}</div>
                <code style={{ fontSize: "0.65rem", fontFamily: T.fontMono, color: T.purple }}>{f.fn}()</code>
              </div>
            ))}
          </div>
        </FadeIn>

        {/* Data flow pipe */}
        <FadeIn>
          <div style={{
            marginTop: "36px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            fontSize: "0.75rem",
            fontFamily: T.fontMono,
            color: "#c9d1d9",
            maxWidth: "700px",
          }}>
            <span style={{ background: "rgba(163,113,247,0.15)", padding: "5px 12px", borderRadius: "6px", color: T.purple }}>your benchmarks</span>
            <span style={{ color: "#6e7681" }}>→</span>
            <span style={{ background: "rgba(163,113,247,0.15)", padding: "5px 12px", borderRadius: "6px", color: T.purple }}>parseBenchmarks()</span>
            <span style={{ color: "#6e7681" }}>→</span>
            <span style={{ background: "rgba(47,129,247,0.15)", padding: "5px 12px", borderRadius: "6px", color: T.blue }}>OTLP JSON</span>
            <span style={{ color: "#6e7681" }}>→</span>
            <span style={{ background: "rgba(63,185,80,0.15)", padding: "5px 12px", borderRadius: "6px", color: T.green }}>adapter / chart</span>
            <span style={{ color: "#6e7681" }}>→</span>
            <span style={{ background: "rgba(255,166,87,0.15)", padding: "5px 12px", borderRadius: "6px", color: T.orange }}>rendered chart</span>
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 6 — Quick start for each path
          ═══════════════════════════════════════════════════ */}
      <section className="custom-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #08101e 0%, #0b1628 50%, #070e1f 100%)",
        color: T.textOnDark,
      }}>
        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "620px", marginBottom: "32px" }}>
            <div style={chapterTag("#f0c000")}>Quick Start</div>
            <h2 style={{ margin: 0, fontSize: "1.8rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              Pick your path
            </h2>
          </div>
        </FadeIn>

        <FadeIn>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "20px", maxWidth: "900px", width: "100%", alignItems: "flex-start" }}>
            {/* Path A */}
            <div style={{ flex: "1 1 380px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                <span style={{ background: "rgba(47,129,247,0.2)", color: T.blue, padding: "2px 10px", borderRadius: "8px", fontSize: "0.72rem", fontWeight: 700 }}>PATH A</span>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#e6edf3" }}>Drop-in dashboard</span>
              </div>
              <YamlBlock filename="App.tsx">{`import { Dashboard } from "@benchkit/chart";

export function App() {
  return (
    <Dashboard
      source={{
        owner: "your-org",
        repo: "your-repo",
      }}
    />
  );
}
// That's it. Trend charts, regression
// detection, leaderboards — all included.`}</YamlBlock>
            </div>

            {/* Path B */}
            <div style={{ flex: "1 1 380px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                <span style={{ background: "rgba(63,185,80,0.2)", color: T.green, padding: "2px 10px", borderRadius: "8px", fontSize: "0.72rem", fontWeight: 700 }}>PATH B</span>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#e6edf3" }}>Custom with adapters</span>
              </div>
              <YamlBlock filename="MyChart.tsx">{`import { trendLineData }
  from "@benchkit/adapters/recharts";
import { LineChart, Line } from "recharts";
import { fetchSeries } from "@benchkit/chart";

const sf = await fetchSeries(source, "ns_per_op");
const data = trendLineData(
  sf.series["BenchmarkSort"],
  { maxPoints: 50 }
);

<LineChart data={data}>
  <Line dataKey="value" stroke="#2f81f7" />
</LineChart>`}</YamlBlock>
            </div>
          </div>
        </FadeIn>

        <FadeIn>
          <div style={{
            marginTop: "28px",
            background: "rgba(240,192,0,0.06)",
            border: "1px solid rgba(240,192,0,0.15)",
            borderRadius: "12px",
            padding: "18px 24px",
            maxWidth: "900px",
            width: "100%",
            fontSize: "0.82rem",
            color: "#c9d1d9",
            lineHeight: 1.7,
          }}>
            <strong style={{ color: "#f0c000" }}>💡 Mix and match.</strong>{" "}
            You can use <code style={{ fontFamily: T.fontMono }}>@benchkit/chart</code> for the dashboard shell and{" "}
            <code style={{ fontFamily: T.fontMono }}>@benchkit/adapters</code> for individual charts
            that need a different library. They share the same data source.
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
