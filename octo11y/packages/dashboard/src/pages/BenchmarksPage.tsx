import { useMemo } from "preact/hooks";
import { TrendChart } from "@benchkit/chart";
import type { SeriesFile } from "@benchkit/format";
import { T } from "../tokens";
import { ACCENT_COLORS } from "../tokens";
import type { Route } from "../router";
import { METRIC_ICONS, METRIC_UNITS, fmtMetric, fmtSeriesName, fmtValue, commitHref, timeAgo } from "../constants";
import type { BenchData } from "../hooks/use-bench-data";
import { deriveBenchmarks } from "../hooks/use-bench-data";
import { StatPill, Card, SectionHeading, EmptyState } from "../components/ui";

export function BenchmarksPage(props: {
  data: BenchData;
  go: (r: Route) => void;
}) {
  const { data, go } = props;
  const benchmarks = useMemo(() => data.index ? deriveBenchmarks(data.seriesMap) : [], [data.index, data.seriesMap]);
  const metricNames = useMemo(() => data.index?.metrics ?? [], [data.index]);
  const runCount = data.index?.runs.length ?? 0;

  if (data.loading) return <EmptyState title="Loading benchmarks…" body="Fetching index and series data." />;
  if (data.error) return <EmptyState title="Error loading data" body={data.error} />;
  if (!data.index) return <EmptyState title="No data" body="No benchmark data found." />;

  return (
    <div style={{ display: "grid", gap: "32px" }}>
      {/* Stats bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <StatPill label="Benchmarks" value={benchmarks.length} color={T.blue} />
        <StatPill label="Metrics" value={metricNames.length} color={T.green} />
        <StatPill label="Runs" value={runCount} color={T.purple} />
        <StatPill label="Series" value={[...data.seriesMap.values()].reduce((s, sf) => s + Object.keys(sf.series).length, 0)} color={T.orange} />
      </div>

      {/* Metric chips – quick navigation */}
      <section>
        <SectionHeading title="Metrics" subtitle="Click a metric to see it across all benchmarks." />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {metricNames.map((m) => (
            <button
              key={m}
              onClick={() => go({ page: "metric", name: m })}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                border: `1px solid ${T.border}`,
                background: T.bgCard,
                borderRadius: "20px",
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: "0.8rem",
                fontWeight: 600,
                fontFamily: T.font,
                color: T.textPrimary,
                boxShadow: T.shadow,
              }}
            >
              <span>{METRIC_ICONS[m] ?? "📈"}</span>
              <span>{fmtMetric(m)}</span>
              <span style={{ color: T.textMuted, fontWeight: 400 }}>{METRIC_UNITS[m] ?? ""}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Benchmark tiles */}
      <section>
        <SectionHeading
          title="Benchmarks"
          subtitle={`${benchmarks.length} benchmark${benchmarks.length === 1 ? "" : "s"} tracked across ${runCount} run${runCount === 1 ? "" : "s"}.`}
        />
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {benchmarks.map((bench, bi) => (
            <Card
              key={bench.name}
              onClick={() => go({ page: "benchmark", name: bench.name })}
              borderColor={ACCENT_COLORS[bi % ACCENT_COLORS.length]}
            >
              <div style={{ marginBottom: "12px" }}>
                <div style={{ fontWeight: 700, fontSize: "0.95rem", color: T.textPrimary, marginBottom: "2px" }}>
                  {bench.displayName}
                </div>
                {bench.tags && Object.keys(bench.tags).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                    {Object.entries(bench.tags).map(([k, v]) => (
                      <span key={k} style={{ fontSize: "0.68rem", background: T.bgPage, border: `1px solid ${T.borderSubtle}`, borderRadius: "4px", padding: "1px 6px", color: T.textSecondary }}>
                        {k}={v}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Metric summary pills */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}>
                {Array.from(bench.metrics.entries()).map(([metric, mdata]) => (
                  <span
                    key={metric}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      fontSize: "0.75rem",
                      background: T.bgPage,
                      border: `1px solid ${T.borderSubtle}`,
                      borderRadius: "4px",
                      padding: "2px 8px",
                    }}
                  >
                    <span style={{ color: T.textSecondary }}>{fmtMetric(metric)}</span>
                    <span style={{ fontWeight: 700, color: T.textPrimary }}>{fmtValue(mdata.latest, metric)}</span>
                    <span style={{ color: T.textMuted }}>{METRIC_UNITS[metric] ?? ""}</span>
                  </span>
                ))}
              </div>

              {/* Mini sparkline for the first metric */}
              {(() => {
                const firstMetric = bench.metrics.keys().next().value as string | undefined;
                if (!firstMetric) return null;
                const sf = data.seriesMap.get(firstMetric);
                if (!sf) return null;
                const entry = sf.series[bench.name];
                if (!entry) return null;
                const singleSeries: SeriesFile = { metric: sf.metric, unit: sf.unit, direction: sf.direction, series: { [bench.name]: entry } };
                return (
                  <div style={{ margin: "0 -4px" }}>
                    <TrendChart
                      series={singleSeries}
                      height={80}
                      maxPoints={20}
                      compact={true}
                      showLegend={false}
                      showSeriesCount={false}
                      seriesNameFormatter={fmtSeriesName}
                    />
                  </div>
                );
              })()}

              {/* Footer meta */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "8px", fontSize: "0.72rem", color: T.textMuted }}>
                <span>{bench.latestTimestamp ? timeAgo(bench.latestTimestamp) : "–"}</span>
                {bench.latestCommit && (
                  <code style={{ fontFamily: T.fontMono, fontSize: "0.7rem" }}>
                    {bench.latestCommit.slice(0, 7)}
                  </code>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Recent runs */}
      <section>
        <SectionHeading title="Recent runs" subtitle="Click a run to see its full detail." />
        <Card>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${T.border}`, textAlign: "left" as const }}>
                  <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Run</th>
                  <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Time</th>
                  <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Commit</th>
                  <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Ref</th>
                  <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Metrics</th>
                </tr>
              </thead>
              <tbody>
                {(data.index?.runs ?? []).slice(0, 10).map((run) => {
                  const refShort = (run.ref ?? "").replace("refs/heads/", "").replace("refs/pull/", "PR #").replace("/merge", "");
                  return (
                    <tr
                      key={run.id}
                      onClick={() => go({ page: "run", id: run.id })}
                      style={{ borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer" }}
                    >
                      <td style={{ padding: "8px 12px" }}>
                        <code style={{ fontFamily: T.fontMono, fontSize: "0.75rem" }}>{run.id}</code>
                      </td>
                      <td style={{ padding: "8px 12px", color: T.textSecondary }}>{timeAgo(run.timestamp)}</td>
                      <td style={{ padding: "8px 12px" }}>
                        {run.commit ? (
                          <a
                            href={commitHref(run.commit)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e: Event) => e.stopPropagation()}
                            style={{ color: T.blue, textDecoration: "none", fontFamily: T.fontMono, fontSize: "0.75rem" }}
                          >
                            {run.commit.slice(0, 7)}
                          </a>
                        ) : "–"}
                      </td>
                      <td style={{ padding: "8px 12px", color: T.textSecondary }}>{refShort || "–"}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                          {(run.metrics ?? []).map((m) => (
                            <span key={m} style={{ fontSize: "0.7rem", background: T.bgPage, border: `1px solid ${T.borderSubtle}`, borderRadius: "4px", padding: "1px 6px", color: T.textSecondary }}>
                              {fmtMetric(m)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
