import { T } from "../tokens";
import type { Route } from "../router";
import { PRODUCT_REPO_OWNER, PRODUCT_REPO_NAME, fmtValue } from "../constants";
import { useRepoMetrics } from "../hooks/use-repo-metrics";
import { Sparkline, YamlBlock, FadeIn } from "../components/ui";
import { useEffect } from "preact/hooks";

export function GuidePage(props: { go: (r: Route) => void }) {
  const rm = useRepoMetrics();
  const met = (name: string) => rm.metrics.find((x) => x.name === name);

  /* ── Enable scroll-snap on the viewport while this page is mounted ── */
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

      {/* Keyframes */}
      <style>{`
        .guide-snap {
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        @keyframes twinkle {
          0%, 100% { opacity: 0.15; transform: scale(1); }
          50%      { opacity: 0.75; transform: scale(1.4); }
        }
        @keyframes ghostPulse {
          0%, 30%  { opacity: 1; filter: blur(0); }
          50%      { opacity: 0.12; filter: blur(3px); }
          70%, 100%{ opacity: 1; filter: blur(0); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-10px); }
        }
      `}</style>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 1 — Once upon a commit
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #070b1e 0%, #0f1538 40%, #1a1248 100%)",
        color: T.textOnDark,
      }}>
        {/* star field */}
        <div style={{ position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none" }}>
          {Array.from({ length: 40 }, (_, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${(i * 37 + 13) % 100}%`,
                top: `${(i * 53 + 7) % 100}%`,
                fontSize: `${6 + (i % 5) * 3}px`,
                color: i % 3 === 0 ? "#f0c000" : "#e6edf3",
                opacity: 0.15 + (i % 6) * 0.08,
                animation: `twinkle ${2.2 + (i % 4) * 0.8}s ease-in-out infinite ${(i % 9) * 0.4}s`,
              }}
            >
              ✦
            </span>
          ))}
        </div>

        <FadeIn>
          <div style={{ textAlign: "center", maxWidth: "620px", position: "relative", zIndex: "1" }}>
            <div style={{ fontSize: "5rem", marginBottom: "28px", animation: "float 4s ease-in-out infinite" }}>🌟</div>
            <div style={chapterTag("#7c8aff")}>Chapter One</div>
            <h1 style={{
              fontSize: "clamp(2.2rem, 5vw, 3.4rem)",
              fontWeight: 800,
              lineHeight: 1.1,
              margin: "0 0 24px",
              letterSpacing: "-0.03em",
              background: "linear-gradient(135deg, #e6edf3 30%, #a5b4c4 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              Once upon a commit…
            </h1>
            <p style={{
              fontSize: "1.2rem",
              lineHeight: 1.75,
              color: "rgba(230,237,243,0.65)",
              maxWidth: "480px",
              margin: "0 auto",
            }}>
              There was a maintainer who loved their open-source project.
              Every day they pushed code, reviewed PRs, and watched
              their little repo grow.
            </p>
            <div style={{ marginTop: "56px", fontSize: "0.78rem", color: "rgba(255,255,255,0.22)", letterSpacing: "0.12em" }}>
              ↓ scroll to turn the page
            </div>
          </div>
        </FadeIn>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 2 — The maintainer loved checking the numbers
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #fffbf0 0%, #fff7e0 100%)",
        color: T.textPrimary,
        padding: "100px 24px",
      }}>
        <div style={{ maxWidth: "680px", width: "100%" }}>
          <FadeIn>
            <div style={chapterTag(T.orange)}>Chapter Two</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px", letterSpacing: "-0.02em" }}>
              They loved checking the numbers.
            </h2>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary, marginBottom: "44px" }}>
              Stars? Going up! Forks? People are building on this!
              Issues?&nbsp;Well… at least folks care enough to file bugs.
            </p>
          </FadeIn>

          <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {[
              { icon: "⭐", label: "Stars", name: "stars", quip: "\"People like me!\"", color: "#e8a400" },
              { icon: "🍴", label: "Forks", name: "forks", quip: "\"They're building on it!\"", color: T.green },
              { icon: "🐛", label: "Open Issues", name: "open_issues", quip: "\"…this is fine.\"", color: T.orange },
              { icon: "👥", label: "Contributors", name: "contributors", quip: "\"I'm not alone!\"", color: T.purple },
              { icon: "✅", label: "CI Success", name: "workflow_success_pct", quip: "\"Green means go!\"", color: "#1a9e3f" },
              { icon: "📦", label: "Releases", name: "releases", quip: "\"Ship it!\"", color: T.blue },
            ].map((item, i) => {
              const m = met(item.name);
              return (
                <FadeIn key={item.name} delay={i * 100}>
                  <div style={{
                    background: "#ffffff",
                    borderRadius: "20px",
                    padding: "28px 20px",
                    boxShadow: "0 2px 16px rgba(0,0,0,0.05)",
                    border: "1px solid rgba(0,0,0,0.04)",
                    textAlign: "center",
                  }}>
                    <div style={{ fontSize: "2.6rem", marginBottom: "10px" }}>{item.icon}</div>
                    <div style={{ fontSize: "0.68rem", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>
                      {item.label}
                    </div>
                    {m ? (
                      <>
                        <div style={{ fontSize: "2.2rem", fontWeight: 800, color: item.color, lineHeight: 1 }}>
                          {fmtValue(m.latest, item.name)}
                        </div>
                        <div style={{ margin: "10px auto 0", maxWidth: "140px" }}>
                          <Sparkline points={m.points} width={140} height={28} color={item.color} filled />
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: "2.2rem", fontWeight: 800, color: item.color, lineHeight: 1 }}>✨</div>
                    )}
                    <div style={{ fontSize: "0.82rem", color: T.textSecondary, marginTop: "10px", fontStyle: "italic" }}>
                      {item.quip}
                    </div>
                  </div>
                </FadeIn>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 3 — The numbers had a terrible habit
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #e4e9ee 0%, #cdd4dc 50%, #b5bec8 100%)",
        color: T.textPrimary,
      }}>
        <div style={{ maxWidth: "580px", textAlign: "center" }}>
          <FadeIn>
            <div style={chapterTag("#8b949e")}>Chapter Three</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 20px", letterSpacing: "-0.02em" }}>
              But the numbers had a terrible habit.
            </h2>
          </FadeIn>

          <FadeIn delay={350}>
            <div style={{ fontSize: "5.5rem", marginBottom: "12px", opacity: 0.5 }}>💨</div>
            <h3 style={{ fontSize: "2rem", fontWeight: 800, color: T.textSecondary, margin: "0 0 8px" }}>
              They'd{" "}
              <span style={{ textDecoration: "line-through", opacity: 0.35 }}>disappear</span>.
            </h3>
          </FadeIn>

          <FadeIn delay={600}>
            <div style={{
              display: "grid",
              gap: "12px",
              gridTemplateColumns: "1fr 1fr 1fr",
              maxWidth: "380px",
              margin: "36px auto 0",
            }}>
              {["⭐ 142", "✅ 94%", "🐛 7"].map((label, i) => (
                <div
                  key={label}
                  style={{
                    background: "rgba(255,255,255,0.6)",
                    borderRadius: "14px",
                    padding: "18px 8px",
                    fontSize: "1.05rem",
                    fontWeight: 700,
                    animation: `ghostPulse 3.5s ease-in-out infinite ${i * 0.6}s`,
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          </FadeIn>

          <FadeIn delay={900}>
            <p style={{
              fontSize: "1.05rem",
              lineHeight: 1.75,
              color: T.textSecondary,
              maxWidth: "460px",
              margin: "36px auto 0",
            }}>
              Workflow logs expired. API responses were ephemeral.
              Yesterday's star count? Gone. Last week's CI health? Who knows.
            </p>
            <p style={{
              fontSize: "1.1rem",
              fontStyle: "italic",
              color: "#656d76",
              marginTop: "20px",
            }}>
              The data was there — and then it wasn't.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 4 — They found a YAML file
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1117 0%, #0f2027 35%, #203a43 70%, #2c5364 100%)",
        color: T.textOnDark,
        padding: "100px 24px 120px",
      }}>
        <div style={{ maxWidth: "660px", width: "100%", textAlign: "center" }}>
          <FadeIn>
            <div style={chapterTag(T.green)}>Chapter Four</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 12px" }}>
              Then they found a YAML file.
            </h2>
            <div style={{ fontSize: "4.5rem", margin: "28px 0", animation: "float 3.5s ease-in-out infinite" }}>📜</div>
          </FadeIn>

          <FadeIn delay={350}>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: "rgba(230,237,243,0.65)", marginBottom: "36px" }}>
              Just one file. Dropped into{" "}
              <code style={{ fontFamily: T.fontMono, background: "rgba(255,255,255,0.1)", padding: "2px 8px", borderRadius: "6px" }}>
                .github/workflows/
              </code>
            </p>
          </FadeIn>

          <FadeIn delay={600}>
            <div style={{ textAlign: "left" }}>
              <YamlBlock filename=".github/workflows/track-my-repo.yml">
{`name: Track My Repo
on:
  schedule:
    - cron: "0 6 * * *"     # Every morning at sunrise 🌅
  workflow_dispatch:         # Or whenever you feel like it

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Gather the numbers
        run: |
          STARS=$(gh api repos/\${{ github.repository }} --jq .stargazers_count)
          ISSUES=$(gh api repos/\${{ github.repository }} --jq .open_issues_count)
          echo '{"benchmarks":[{"name":"my-project","metrics":{
            "stars":  {"value":'$STARS',  "direction":"bigger_is_better"},
            "issues": {"value":'$ISSUES', "direction":"smaller_is_better"}
          }}]}' > stats.json
        env:
          GH_TOKEN: \${{ github.token }}

      - name: Save them forever ✨
        uses: strawgate/o11ykit/octo11y/actions/stash@main-dist
        with: { results: stats.json, format: otlp }

      - name: Build the timeline
        uses: strawgate/o11ykit/octo11y/actions/aggregate@main-dist`}
              </YamlBlock>
            </div>
          </FadeIn>

          <FadeIn delay={900}>
            <p style={{ fontSize: "1.1rem", color: "rgba(230,237,243,0.55)", marginTop: "36px", fontStyle: "italic" }}>
              And just like that — every number had a home.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 5 — The numbers found their rhythm
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #f0f7ff 0%, #e4effc 100%)",
        color: T.textPrimary,
        padding: "100px 24px",
      }}>
        <div style={{ maxWidth: "640px", width: "100%" }}>
          <FadeIn>
            <div style={chapterTag(T.blue)}>Chapter Five</div>
            <h2 style={{ fontSize: "clamp(1.5rem, 3.5vw, 2.2rem)", fontWeight: 800, lineHeight: 1.2, margin: "0 0 12px" }}>
              The numbers found their rhythm.
            </h2>
            <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary, marginBottom: "44px" }}>
              Every morning the workflow woke up, collected the metrics,
              and stashed them on a data branch. Over time, a story emerged.
            </p>
          </FadeIn>

          {/* Pipeline steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0", position: "relative" }}>
            {/* Vertical line */}
            <div style={{
              position: "absolute",
              left: "31px",
              top: "36px",
              bottom: "36px",
              width: "3px",
              borderRadius: "3px",
              background: `linear-gradient(180deg, ${T.blue}, ${T.green}, ${T.purple}, ${T.orange})`,
              opacity: 0.2,
            }} />

            {[
              { icon: "⚡", title: "Collect", desc: "GitHub API, CLI, or any script — grab the numbers", color: T.blue },
              { icon: "📦", title: "Stash", desc: "Write an immutable snapshot to the data branch", color: T.green },
              { icon: "🔄", title: "Aggregate", desc: "Rebuild indexes and per-metric time-series JSON", color: T.purple },
              { icon: "📊", title: "Visualize", desc: "Sparklines, trends, PR comments, regression alerts", color: T.orange },
            ].map((step, i) => (
              <FadeIn key={step.title} delay={i * 200}>
                <div style={{ display: "flex", gap: "18px", alignItems: "center", padding: "18px 0", position: "relative" }}>
                  <div style={{
                    width: "64px",
                    height: "64px",
                    borderRadius: "18px",
                    background: step.color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.6rem",
                    flexShrink: "0",
                    boxShadow: `0 4px 20px ${step.color}30`,
                    zIndex: "1",
                  }}>
                    {step.icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>{step.title}</div>
                    <div style={{ fontSize: "0.9rem", color: T.textSecondary, lineHeight: 1.5 }}>{step.desc}</div>
                  </div>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 6 — Now they could see everything
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "#ffffff",
        color: T.textPrimary,
        padding: "100px 24px 120px",
      }}>
        <div style={{ maxWidth: "740px", width: "100%" }}>
          <FadeIn>
            <div style={{ textAlign: "center", marginBottom: "52px" }}>
              <div style={chapterTag(T.green)}>Chapter Six</div>
              <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 16px" }}>
                And now they could see <em>everything</em>.
              </h2>
              <p style={{ fontSize: "1.05rem", lineHeight: 1.7, color: T.textSecondary, maxWidth: "520px", margin: "0 auto" }}>
                Every metric, tracked over time. Each number telling its part of the story.
                {rm.metrics.length > 0
                  ? " Here's what this very repo looks like right now:"
                  : " Set up the pipeline and your metrics will appear here."}
              </p>
            </div>
          </FadeIn>

          {rm.metrics.length > 0 ? (
            <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
              {rm.metrics.map((m, i) => (
                <FadeIn key={m.name} delay={i * 120}>
                  <div style={{
                    background: T.bgPage,
                    borderRadius: "18px",
                    padding: "22px",
                    border: `1px solid ${T.borderSubtle}`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                      <div>
                        <span style={{ fontSize: "1.4rem" }}>{m.icon}</span>
                        <div style={{ fontSize: "0.68rem", fontWeight: 700, color: T.textMuted, marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          {m.label}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "1.6rem", fontWeight: 800, color: T.textPrimary, lineHeight: 1 }}>
                          {fmtValue(m.latest, m.name)}
                        </div>
                        <div style={{ fontSize: "0.65rem", color: T.textMuted, marginTop: "2px" }}>{m.unit}</div>
                      </div>
                    </div>
                    <Sparkline
                      points={m.points}
                      width={180}
                      height={40}
                      color={m.direction === "smaller_is_better" ? T.orange : T.green}
                      filled
                    />
                  </div>
                </FadeIn>
              ))}
            </div>
          ) : !rm.loading && (
            <FadeIn delay={300}>
              <div style={{
                textAlign: "center",
                padding: "48px 24px",
                borderRadius: "20px",
                border: `2px dashed ${T.border}`,
                color: T.textMuted,
              }}>
                <div style={{ fontSize: "3.5rem", marginBottom: "16px" }}>📊</div>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>No data yet</div>
                <div style={{ fontSize: "0.9rem", marginTop: "6px" }}>
                  Once you set up the workflow, your metrics will appear here like magic.
                </div>
              </div>
            </FadeIn>
          )}
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════
          CHAPTER 7 — Every repo has a story
          ═══════════════════════════════════════════════════ */}
      <section className="guide-snap" style={{
        ...page,
        background: "linear-gradient(180deg, #0d1117 0%, #161b22 100%)",
        color: T.textOnDark,
      }}>
        <div style={{ textAlign: "center", maxWidth: "580px" }}>
          <FadeIn>
            <div style={{ fontSize: "5rem", marginBottom: "28px", animation: "float 4s ease-in-out infinite" }}>📖</div>
            <h2 style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 20px" }}>
              Every repo has a story.
            </h2>
            <p style={{ fontSize: "1.1rem", lineHeight: 1.75, color: "rgba(230,237,243,0.65)", marginBottom: "44px" }}>
              Your CI runs every day. Your numbers change every week.
              Octo11y just makes sure someone's writing it all down.
            </p>
          </FadeIn>

          <FadeIn delay={350}>
            <div style={{ display: "flex", justifyContent: "center", gap: "14px", flexWrap: "wrap" }}>
              <button
                onClick={() => props.go({ page: "benchmarks" })}
                style={{
                  border: "none",
                  background: T.green,
                  color: "#fff",
                  padding: "16px 36px",
                  borderRadius: "14px",
                  cursor: "pointer",
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  fontFamily: T.font,
                  boxShadow: `0 4px 20px ${T.green}40`,
                }}
              >
                See the live dashboard →
              </button>
              <a
                href={`https://github.com/${PRODUCT_REPO_OWNER}/${PRODUCT_REPO_NAME}`}
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
                GitHub →
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
              Zero servers · Zero databases · Just GitHub Actions and a data branch
            </div>
          </FadeIn>
        </div>
      </section>
    </div>
  );
}
