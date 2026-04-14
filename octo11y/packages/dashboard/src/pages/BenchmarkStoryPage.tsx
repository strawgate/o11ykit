import { T } from "../tokens";
import { ACCENT_COLORS } from "../tokens";
import type { Route } from "../router";
import {
  PRODUCT_REPO_OWNER,
  PRODUCT_REPO_NAME,
  METRIC_UNITS,
  fmtMetric,
  fmtValue,
} from "../constants";
import { useBenchData, deriveBenchmarks } from "../hooks/use-bench-data";
import { Sparkline, YamlBlock, FadeIn } from "../components/ui";

import { useEffect, useMemo } from "preact/hooks";

export function BenchmarkStoryPage(props: { go: (r: Route) => void }) {
  const data = useBenchData();
  const benchmarks = useMemo(() => data.index ? deriveBenchmarks(data.seriesMap) : [], [data.index, data.seriesMap]);
  const runCount = data.index?.runs.length ?? 0;

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
        .bench-snap {
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        @keyframes streak {
          0%   { transform: translateX(-100%); opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateX(100vw); opacity: 0; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-10px); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.08); }
        }
        @keyframes ghostRegress {
          0%, 35%  { opacity: 1; }
          50%      { opacity: 0.1; }
          65%      { opacity: 1; }
          65.1%    { color: #ef4444; }
          100%     { color: #ef4444; }
        }
        @keyframes laneRace {
          0%   { width: 0; }
          100% { width: var(--lane-w); }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 40px rgba(251,191,36,0.2); }
          50%      { box-shadow: 0 0 80px rgba(251,191,36,0.45); }
        }
        @keyframes pipelineNode {
          0%   { opacity: 0.3; transform: scale(0.9); }
          50%  { opacity: 1;   transform: scale(1.05); }
          100% { opacity: 0.3; transform: scale(0.9); }
        }
      `}</style>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 1 — Every millisecond has a name
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0a0e27 0%, #12062e 50%, #1a0a3a 100%)",
        color: T.textOnDark,
      }}>
        {/* speed streaks */}
        <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none" }}>
          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: "0",
                top: `${8 + (i * 41 + 17) % 84}%`,
                fontSize: `${8 + (i % 4) * 3}px`,
                color: i % 3 === 0 ? "#fbbf24" : i % 3 === 1 ? "#a78bfa" : "#60a5fa",
                opacity: 0.25 + (i % 5) * 0.08,
                animation: `streak ${2 + (i % 5) * 0.6}s linear infinite ${(i % 8) * 0.5}s`,
              }}
            >
              ⚡
            </span>
          ))}
        </div>

        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "620px", position: "relative", zIndex: "1" }}>
            <div style={{ fontSize: "5rem", marginBottom: "28px", animation: "pulse 2s ease-in-out infinite" }}>⏱️</div>
            <div style={chapterTag("#a78bfa")}>Chapter One</div>
            <h1 style={{
              fontSize: "clamp(2.2rem, 5vw, 3.4rem)",
              fontWeight: 800,
              lineHeight: 1.1,
              margin: "0 0 24px",
              letterSpacing: "-0.03em",
              background: "linear-gradient(135deg, #fbbf24 0%, #e6edf3 60%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              Every millisecond has a name.
            </h1>
            <p style={{
              fontSize: "1.2rem",
              lineHeight: 1.75,
              color: "rgba(230,237,243,0.65)",
              maxWidth: "480px",
              margin: "0 auto",
            }}>
              Your code is an athlete. Every function has a personal best.
              Every commit is a race. But if nobody's holding the stopwatch…
              who would notice if it got slower?
            </p>
            <div style={{ marginTop: "56px", fontSize: "0.78rem", color: "rgba(255,255,255,0.22)", letterSpacing: "0.12em" }}>
              ↓ scroll to turn the page
            </div>
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 2 — The silent regression
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #fffbf0 0%, #fff3d6 100%)",
        color: T.textPrimary,
      }}>
        <div style={{ maxWidth: "580px", textAlign: "center" }}>
          <FadeIn>
            <div style={chapterTag("#ef4444")}>Chapter Two</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px", letterSpacing: "-0.02em" }}>
              The silent regression.
            </h2>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary, marginBottom: "8px" }}>
              It didn't happen all at once. A PR here. A dependency
              bump there. Nobody ran the benchmarks. Nobody checked the numbers.
            </p>
          </FadeIn>

          <FadeIn delay={300}>
            <div style={{ fontSize: "5rem", marginBottom: "12px" }}>🐌</div>
          </FadeIn>

          <FadeIn delay={500}>
            <div style={{
              display: "grid",
              gap: "12px",
              gridTemplateColumns: "1fr 1fr 1fr",
              maxWidth: "420px",
              margin: "24px auto 0",
            }}>
              {[
                { label: "Sort", before: "142 ns", after: "380 ns" },
                { label: "Search", before: "8 ns", after: "45 ns" },
                { label: "Insert", before: "200 ns", after: "1,240 ns" },
              ].map((item, i) => (
                <div
                  key={item.label}
                  style={{
                    background: "rgba(255,255,255,0.85)",
                    borderRadius: "16px",
                    padding: "18px 10px",
                    boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
                    border: "1px solid rgba(0,0,0,0.04)",
                  }}
                >
                  <div style={{ fontSize: "0.7rem", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>
                    {item.label}
                  </div>
                  <div style={{
                    fontSize: "1.1rem",
                    fontWeight: 800,
                    animation: `ghostRegress 4s ease-in-out infinite ${i * 0.8}s`,
                  }}>
                    <span style={{ opacity: 0 }}>{item.before}</span>
                    {item.after}
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "#ef4444", marginTop: "4px", fontWeight: 600 }}>
                    was {item.before}
                  </div>
                </div>
              ))}
            </div>
          </FadeIn>

          <FadeIn delay={800}>
            <p style={{
              fontSize: "1.05rem",
              lineHeight: 1.75,
              color: T.textSecondary,
              maxWidth: "440px",
              margin: "32px auto 0",
            }}>
              And one morning — the API that used to respond in 12ms… took 200.
            </p>
            <p style={{ fontSize: "1.1rem", fontStyle: "italic", color: "#656d76", marginTop: "16px" }}>
              The regression was there for weeks. Nobody noticed.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 3 — What if your CI held the stopwatch?
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1117 0%, #1a2332 50%, #243447 100%)",
        color: T.textOnDark,
      }}>
        <div style={{ maxWidth: "620px", textAlign: "center" }}>
          <FadeIn>
            <div style={chapterTag("#fbbf24")}>Chapter Three</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px" }}>
              What if your CI held the stopwatch?
            </h2>
            <div style={{ fontSize: "4.5rem", margin: "24px 0", animation: "float 3.5s ease-in-out infinite" }}>🏟️</div>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: "rgba(230,237,243,0.65)", marginBottom: "40px" }}>
              Imagine every push triggers a race. Your benchmarks line up
              at the starting blocks. The gun fires.
              And the results? Recorded. Forever.
            </p>
          </FadeIn>

          {/* Race lanes */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "500px", margin: "0 auto" }}>
            {[
              { name: "Sort", time: "142 ns/op", pct: 85, color: "#fbbf24", medal: "🥇" },
              { name: "Search", time: "8.2 ns/op", pct: 78, color: "#94a3b8", medal: "🥈" },
              { name: "Insert", time: "204 ns/op", pct: 65, color: "#d97706", medal: "🥉" },
            ].map((lane, i) => (
              <FadeIn key={lane.name} delay={i * 250}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: "80px", textAlign: "right", fontSize: "0.78rem", fontWeight: 700, color: "rgba(230,237,243,0.8)", flexShrink: "0" }}>
                    {lane.medal} {lane.name}
                  </div>
                  <div style={{ flex: "1", height: "32px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", overflow: "hidden", position: "relative" }}>
                    <div style={{
                      height: "100%",
                      background: `linear-gradient(90deg, ${lane.color}90, ${lane.color})`,
                      borderRadius: "8px",
                      width: `${lane.pct}%`,
                      animation: `laneRace 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) ${0.6 + i * 0.3}s both`,
                      ["--lane-w" as string]: `${lane.pct}%`,
                    }} />
                  </div>
                  <div style={{ width: "90px", fontSize: "0.78rem", fontWeight: 700, color: lane.color, fontFamily: T.fontMono }}>
                    {lane.time}
                  </div>
                </div>
              </FadeIn>
            ))}
          </div>

          {/* Monitor callout */}
          <FadeIn delay={1000}>
            <div style={{
              marginTop: "48px",
              padding: "24px 28px",
              background: "rgba(251,191,36,0.06)",
              border: "1px solid rgba(251,191,36,0.2)",
              borderRadius: "16px",
              maxWidth: "500px",
              margin: "48px auto 0",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                <span style={{ fontSize: "1.4rem" }}>📡</span>
                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "#fbbf24" }}>
                  With Monitor, every E2E test is a benchmark
                </span>
              </div>
              <p style={{ fontSize: "0.88rem", lineHeight: 1.65, color: "rgba(230,237,243,0.6)", margin: 0 }}>
                Drop in the <code style={{ fontFamily: T.fontMono, background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: "4px", fontSize: "0.8rem" }}>monitor</code> action
                and it spins up an OpenTelemetry Collector in the background.
                CPU, memory, and process metrics stream automatically while your
                tests run — no SDK needed. Your Playwright suite, your integration
                tests, your deploy scripts — they're all benchmarks now.
              </p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 4 — The pipeline never sleeps
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1117 0%, #0f2027 35%, #203a43 70%, #2c5364 100%)",
        color: T.textOnDark,
        padding: "100px 24px 120px",
      }}>
        <div style={{ maxWidth: "660px", width: "100%", textAlign: "center" }}>
          <FadeIn>
            <div style={chapterTag(T.green)}>Chapter Four</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px" }}>
              The pipeline never sleeps.
            </h2>
            <div style={{ fontSize: "4.5rem", margin: "24px 0", animation: "float 3.5s ease-in-out infinite" }}>📜</div>
          </FadeIn>

          <FadeIn delay={350}>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: "rgba(230,237,243,0.65)", marginBottom: "36px" }}>
              One YAML file. Four steps. Every CI run flows through the same
              track. If something slows down — you'll know before it merges.
            </p>
          </FadeIn>

          <FadeIn delay={600}>
            <div style={{ textAlign: "left" }}>
              <YamlBlock filename=".github/workflows/benchmark.yml">
{`name: Benchmark
on: [push, pull_request]

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Go benchmarks 🏃
        run: go test -bench=. -benchmem ./... | tee bench.txt

      - name: Stash the results
        uses: strawgate/o11ykit/octo11y/actions/stash@main-dist
        with: { results: bench.txt, format: go }

      - name: Build the timeline
        uses: strawgate/o11ykit/octo11y/actions/aggregate@main-dist

      - name: Compare & alert 🚨
        uses: strawgate/o11ykit/octo11y/actions/compare@main-dist
        with: { threshold: 15% }`}
              </YamlBlock>
            </div>
          </FadeIn>

          <FadeIn delay={900}>
            {/* Pipeline nodes */}
            <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "36px", flexWrap: "wrap" }}>
              {[
                { icon: "⚡", label: "Benchmark", color: "#fbbf24" },
                { icon: "📦", label: "Stash", color: T.green },
                { icon: "🔄", label: "Aggregate", color: T.purple },
                { icon: "🚨", label: "Compare", color: "#ef4444" },
              ].map((node, i) => (
                <div key={node.label} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {i > 0 && <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "1.2rem" }}>→</span>}
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: `${node.color}18`,
                    border: `1px solid ${node.color}40`,
                    borderRadius: "12px",
                    padding: "8px 14px",
                    animation: `pipelineNode 3s ease-in-out infinite ${i * 0.6}s`,
                  }}>
                    <span style={{ fontSize: "1rem" }}>{node.icon}</span>
                    <span style={{ fontSize: "0.75rem", fontWeight: 700, color: node.color }}>{node.label}</span>
                  </div>
                </div>
              ))}
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 5 — Meet the athletes
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #f0f7ff 0%, #e4effc 100%)",
        color: T.textPrimary,
        padding: "100px 24px",
      }}>
        <div style={{ maxWidth: "740px", width: "100%" }}>
          <FadeIn>
            <div style={{ textAlign: "center", marginBottom: "44px" }}>
              <div style={chapterTag(T.blue)}>Chapter Five</div>
              <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px" }}>
                Meet the athletes.
              </h2>
              <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary, maxWidth: "500px", margin: "0 auto" }}>
                Real functions. Real measurements. Tracked across every commit.
                {benchmarks.length > 0
                  ? " Here they are, training right now:"
                  : " Set up benchmarks and they'll appear here."}
              </p>
            </div>
          </FadeIn>

          {benchmarks.length > 0 ? (
            <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {benchmarks.map((bench, i) => {
                const cardColor = ACCENT_COLORS[i % ACCENT_COLORS.length];
                const firstMetric = bench.metrics.keys().next().value as string | undefined;
                const mdata = firstMetric ? bench.metrics.get(firstMetric) : undefined;
                const cardIcon = i === 0 ? "🔀" : i === 1 ? "🔍" : i === 2 ? "📥" : "🌐";
                const quips = [
                  "Consistent as sunrise.",
                  "Fast and getting faster.",
                  "Steady under pressure.",
                  "Holding the line.",
                  "Rock solid.",
                ];
                return (
                  <FadeIn key={bench.name} delay={i * 150}>
                    <div
                      onClick={() => props.go({ page: "benchmark", name: bench.name })}
                      style={{
                        background: "#ffffff",
                        borderRadius: "20px",
                        padding: "24px 20px",
                        boxShadow: "0 2px 16px rgba(0,0,0,0.05)",
                        border: "1px solid rgba(0,0,0,0.04)",
                        borderTop: `4px solid ${cardColor}`,
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: "2.2rem", marginBottom: "8px" }}>{cardIcon}</div>
                      <div style={{ fontSize: "0.95rem", fontWeight: 800, color: T.textPrimary, marginBottom: "4px" }}>
                        {bench.displayName}
                      </div>
                      {mdata && firstMetric && (
                        <>
                          <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "8px" }}>
                            <span style={{ fontSize: "1.8rem", fontWeight: 800, color: cardColor, lineHeight: 1 }}>
                              {fmtValue(mdata.latest, firstMetric)}
                            </span>
                            <span style={{ fontSize: "0.72rem", color: T.textMuted }}>{METRIC_UNITS[firstMetric] ?? ""}</span>
                          </div>
                          <Sparkline
                            points={mdata.points.map(p => ({ v: p.value }))}
                            width={180}
                            height={36}
                            color={cardColor}
                            filled
                          />
                        </>
                      )}
                      {/* Secondary metrics */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
                        {Array.from(bench.metrics.entries())
                          .filter(([k]) => k !== firstMetric)
                          .slice(0, 2)
                          .map(([k, v]) => (
                            <span key={k} style={{
                              fontSize: "0.68rem",
                              background: T.bgPage,
                              border: `1px solid ${T.borderSubtle}`,
                              borderRadius: "6px",
                              padding: "2px 8px",
                              color: T.textSecondary,
                            }}>
                              {fmtMetric(k)}: <strong>{fmtValue(v.latest, k)}</strong>
                            </span>
                          ))}
                      </div>
                      <div style={{ fontSize: "0.78rem", color: T.textSecondary, marginTop: "10px", fontStyle: "italic" }}>
                        {quips[i % quips.length]}
                      </div>
                    </div>
                  </FadeIn>
                );
              })}
            </div>
          ) : !data.loading && (
            <FadeIn delay={300}>
              <div style={{
                textAlign: "center",
                padding: "48px 24px",
                borderRadius: "20px",
                border: `2px dashed ${T.border}`,
                color: T.textMuted,
              }}>
                <div style={{ fontSize: "3.5rem", marginBottom: "16px" }}>🏋️</div>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>Warming up…</div>
                <div style={{ fontSize: "0.9rem", marginTop: "6px" }}>
                  Set up the benchmark workflow and your athletes will appear here.
                </div>
              </div>
            </FadeIn>
          )}
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 6 — The regression that never shipped
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "#ffffff",
        color: T.textPrimary,
        padding: "100px 24px",
      }}>
        <div style={{ maxWidth: "620px", width: "100%" }}>
          <FadeIn>
            <div style={{ textAlign: "center", marginBottom: "40px" }}>
              <div style={chapterTag("#22c55e")}>Chapter Six</div>
              <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px" }}>
                The regression that never shipped.
              </h2>
              <div style={{ fontSize: "4rem", margin: "20px 0", animation: "float 3s ease-in-out infinite" }}>🛡️</div>
              <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary }}>
                PR #247 looked harmless. But the compare action caught a 34%
                regression in Sort. A comment appeared. The author fixed it.
                The main branch stayed fast.
              </p>
            </div>
          </FadeIn>

          {/* Mock PR comment */}
          <FadeIn delay={400}>
            <div style={{
              background: T.bgPage,
              borderRadius: "16px",
              border: `1px solid ${T.border}`,
              overflow: "hidden",
            }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "14px 18px",
                borderBottom: `1px solid ${T.borderSubtle}`,
                background: "#fff",
              }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #3fb950 0%, #238636 100%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.9rem",
                }}>
                  🤖
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "0.85rem" }}>octo11y-bot</div>
                  <div style={{ fontSize: "0.68rem", color: T.textMuted }}>commented just now</div>
                </div>
              </div>
              <div style={{ padding: "18px" }}>
                <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#ef4444", marginBottom: "14px" }}>
                  🚨 Performance Regression Detected
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${T.border}`, textAlign: "left" as const }}>
                      <th style={{ padding: "6px 10px", fontWeight: 600, color: T.textSecondary }}>Benchmark</th>
                      <th style={{ padding: "6px 10px", fontWeight: 600, color: T.textSecondary }}>Before</th>
                      <th style={{ padding: "6px 10px", fontWeight: 600, color: T.textSecondary }}>After</th>
                      <th style={{ padding: "6px 10px", fontWeight: 600, color: T.textSecondary }}>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { name: "Sort", before: "142 ns/op", after: "191 ns/op", change: "+34.5%", bad: true },
                      { name: "Search", before: "8.2 ns/op", after: "8.1 ns/op", change: "-1.2%", bad: false },
                      { name: "Insert", before: "204 ns/op", after: "198 ns/op", change: "-2.9%", bad: false },
                    ].map((row, i) => (
                      <FadeIn key={row.name} delay={600 + i * 200}>
                        <tr style={{ borderBottom: `1px solid ${T.borderSubtle}` }}>
                          <td style={{ padding: "8px 10px", fontWeight: 700 }}>{row.name}</td>
                          <td style={{ padding: "8px 10px", fontFamily: T.fontMono, fontSize: "0.75rem" }}>{row.before}</td>
                          <td style={{ padding: "8px 10px", fontFamily: T.fontMono, fontSize: "0.75rem", color: row.bad ? "#ef4444" : T.textPrimary }}>
                            {row.after}
                          </td>
                          <td style={{
                            padding: "8px 10px",
                            fontWeight: 700,
                            color: row.bad ? "#ef4444" : "#22c55e",
                          }}>
                            {row.change} {row.bad ? "🔴" : "✅"}
                          </td>
                        </tr>
                      </FadeIn>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={1200}>
            <p style={{
              textAlign: "center",
              fontSize: "1.05rem",
              fontStyle: "italic",
              color: T.textSecondary,
              marginTop: "32px",
            }}>
              Nobody even noticed — and that's the point.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 7 — Your code deserves a personal best
          ═══════════════════════════════════════════════════ */}
      <section className="bench-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1117 0%, #161b22 100%)",
        color: T.textOnDark,
      }}>
        {/* Gold confetti stars */}
        <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none" }}>
          {Array.from({ length: 30 }, (_, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${(i * 43 + 11) % 100}%`,
                top: `${(i * 59 + 13) % 100}%`,
                fontSize: `${6 + (i % 4) * 3}px`,
                color: "#fbbf24",
                opacity: 0.1 + (i % 5) * 0.06,
                animation: `float ${3 + (i % 4) * 0.7}s ease-in-out infinite ${(i % 7) * 0.5}s`,
              }}
            >
              ✦
            </span>
          ))}
        </div>

        <div style={{ textAlign: "center", maxWidth: "580px", position: "relative", zIndex: "1" }}>
          <FadeIn>
            <div style={{
              fontSize: "5rem",
              marginBottom: "28px",
              animation: "float 4s ease-in-out infinite",
              borderRadius: "50%",
            }}>🏆</div>
            <h2 style={{
              fontSize: "clamp(1.7rem, 4vw, 2.6rem)",
              fontWeight: 800,
              lineHeight: 1.15,
              margin: "0 0 20px",
              background: "linear-gradient(135deg, #fbbf24 0%, #e6edf3 70%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              Your code deserves a personal best.
            </h2>
            <p style={{ fontSize: "1.1rem", lineHeight: 1.75, color: "rgba(230,237,243,0.65)", marginBottom: "32px" }}>
              Every repo ships code. The best repos know how fast it runs.
              Track every benchmark. Catch every regression.
              Your code has been training — now give it a scoreboard.
            </p>
          </FadeIn>

          {/* Live stats */}
          {(benchmarks.length > 0 || runCount > 0) && (
            <FadeIn delay={200}>
              <div style={{ display: "flex", justifyContent: "center", gap: "24px", flexWrap: "wrap", marginBottom: "36px" }}>
                {[
                  { label: "benchmarks tracked", value: benchmarks.length },
                  { label: "data points collected", value: runCount },
                  { label: "regressions shipped", value: 0 },
                ].map(s => (
                  <div key={s.label} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "2rem", fontWeight: 800, color: "#fbbf24" }}>{s.value}</div>
                    <div style={{ fontSize: "0.72rem", color: "rgba(230,237,243,0.5)", marginTop: "2px" }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </FadeIn>
          )}

          <FadeIn delay={400}>
            <div style={{ display: "flex", justifyContent: "center", gap: "14px", flexWrap: "wrap" }}>
              <button
                onClick={() => props.go({ page: "benchmarks" })}
                style={{
                  border: "none",
                  background: "#fbbf24",
                  color: "#0d1117",
                  padding: "16px 36px",
                  borderRadius: "14px",
                  cursor: "pointer",
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  fontFamily: T.font,
                  animation: "glow 3s ease-in-out infinite",
                }}
              >
                Explore the dashboard →
              </button>
              <a
                href={`https://github.com/${PRODUCT_REPO_OWNER}/${PRODUCT_REPO_NAME}#getting-started`}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  border: "1px solid #30363d",
                  background: "rgba(255,255,255,0.06)",
                  color: T.textOnDark,
                  padding: "16px 36px",
                  borderRadius: "14px",
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  fontFamily: T.font,
                  textDecoration: "none",
                }}
              >
                Set up your own →
              </a>
            </div>
          </FadeIn>

          <FadeIn delay={600}>
            <div style={{
              marginTop: "56px",
              fontSize: "0.78rem",
              color: "rgba(255,255,255,0.2)",
              letterSpacing: "0.06em",
              lineHeight: 1.8,
            }}>
              Zero servers · Zero databases · Just <code style={{ fontFamily: T.fontMono }}>go test -bench</code> and a YAML file
            </div>
          </FadeIn>
        </div>
      </section>
    </div>
  );
}
