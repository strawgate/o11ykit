import { useMemo } from "preact/hooks";
import { TrendChart, detectRegressions } from "@benchkit/chart";
import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import { T } from "../tokens";
import { ACCENT_COLORS } from "../tokens";
import type { Route } from "../router";
import { METRIC_ICONS, METRIC_UNITS, fmtMetric, fmtBenchName, fmtSeriesName, fmtValue, commitHref, timeAgo } from "../constants";
import type { BenchData } from "../hooks/use-bench-data";
import { Breadcrumb, Card, SectionHeading, EmptyState } from "../components/ui";

export function BenchmarkDetailPage(props: {
  name: string;
  data: BenchData;
  go: (r: Route) => void;
}) {
  const { name, data, go } = props;
  const displayName = fmtBenchName(name);

  const metricEntries = useMemo(() => {
    const entries: Array<{ metric: string; sf: SeriesFile; entry: SeriesEntry }> = [];
    for (const [metric, sf] of data.seriesMap) {
      const entry = sf.series[name];
      if (entry) entries.push({ metric, sf, entry });
    }
    return entries;
  }, [name, data.seriesMap]);

  const relatedRuns = useMemo(() => {
    const runIds = new Set<string>();
    for (const { entry } of metricEntries) {
      for (const p of entry.points ?? []) {
        if (p.run_id) runIds.add(p.run_id);
      }
    }
    return (data.index?.runs ?? []).filter((r) => runIds.has(r.id));
  }, [metricEntries, data.index]);

  if (data.loading) return <EmptyState title="Loading…" body="" />;
  if (metricEntries.length === 0) return <EmptyState title="Benchmark not found" body={`No data for "${name}".`} />;

  const latestPoint = metricEntries[0]?.entry.points?.slice(-1)[0];
  const tags = metricEntries[0]?.entry.tags;

  return (
    <div style={{ display: "grid", gap: "32px" }}>
      <Breadcrumb
        items={[
          { label: "Benchmarks", route: { page: "benchmarks" } },
          { label: displayName },
        ]}
        go={go}
      />

      <div>
        <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 700, color: T.textPrimary }}>{displayName}</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
          {tags && Object.entries(tags).map(([k, v]) => (
            <span key={k} style={{ fontSize: "0.72rem", background: T.bgPage, border: `1px solid ${T.borderSubtle}`, borderRadius: "4px", padding: "2px 8px", color: T.textSecondary }}>
              {k}={v}
            </span>
          ))}
          {latestPoint?.commit && (
            <a href={commitHref(latestPoint.commit)} target="_blank" rel="noreferrer" style={{ fontSize: "0.72rem", color: T.blue, textDecoration: "none", fontFamily: T.fontMono }}>
              Latest: {latestPoint.commit.slice(0, 7)}
            </a>
          )}
        </div>
      </div>

      {/* Latest values */}
      <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
        {metricEntries.map(({ metric, entry }, i) => {
          const latest = entry.points?.slice(-1)[0];
          const prev = entry.points?.slice(-2, -1)[0];
          const delta = latest && prev ? ((latest.value - prev.value) / prev.value * 100) : null;
          return (
            <Card key={metric} onClick={() => go({ page: "metric", name: metric })} borderColor={ACCENT_COLORS[i % ACCENT_COLORS.length]}>
              <div style={{ fontSize: "0.7rem", fontWeight: 600, color: T.textSecondary, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
                {METRIC_ICONS[metric] ?? "📈"} {fmtMetric(metric)}
              </div>
              <div style={{ fontSize: "1.8rem", fontWeight: 700, color: T.textPrimary, lineHeight: 1.2, margin: "4px 0 2px" }}>
                {latest ? fmtValue(latest.value, metric) : "–"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "0.72rem", color: T.textMuted }}>{METRIC_UNITS[metric] ?? ""}</span>
                {delta !== null && (
                  <span style={{ fontSize: "0.72rem", fontWeight: 600, color: delta > 5 ? T.red : delta < -5 ? T.green : T.textMuted }}>
                    {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Trend chart per metric */}
      {metricEntries.map(({ metric, sf, entry }) => {
        const singleSeries: SeriesFile = { metric: sf.metric, unit: sf.unit, direction: sf.direction, series: { [name]: entry } };
        const regressions = detectRegressions(singleSeries, 10, 5);
        return (
          <section key={metric}>
            <SectionHeading
              title={`${fmtMetric(metric)} over time`}
              subtitle={`${METRIC_UNITS[metric] ?? ""} · ${entry.points?.length ?? 0} data point${(entry.points?.length ?? 0) === 1 ? "" : "s"}`}
              right={
                <button
                  onClick={() => go({ page: "metric", name: metric })}
                  style={{ border: `1px solid ${T.border}`, background: T.bgCard, borderRadius: "6px", padding: "4px 12px", cursor: "pointer", fontSize: "0.75rem", fontWeight: 600, color: T.blue, fontFamily: T.font }}
                >
                  All benchmarks →
                </button>
              }
            />
            <Card>
              <TrendChart
                series={singleSeries}
                height={240}
                maxPoints={50}
                seriesNameFormatter={fmtSeriesName}
                regressions={regressions}
              />
            </Card>
          </section>
        );
      })}

      {/* Run history */}
      {relatedRuns.length > 0 && (
        <section>
          <SectionHeading title="Run history" subtitle={`${relatedRuns.length} run${relatedRuns.length === 1 ? "" : "s"} included this benchmark.`} />
          <Card>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${T.border}`, textAlign: "left" as const }}>
                    <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Run</th>
                    <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Time</th>
                    <th style={{ padding: "8px 12px", fontWeight: 600, color: T.textSecondary }}>Commit</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedRuns.slice(0, 20).map((run) => (
                    <tr key={run.id} onClick={() => go({ page: "run", id: run.id })} style={{ borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer" }}>
                      <td style={{ padding: "8px 12px" }}><code style={{ fontFamily: T.fontMono, fontSize: "0.75rem" }}>{run.id}</code></td>
                      <td style={{ padding: "8px 12px", color: T.textSecondary }}>{timeAgo(run.timestamp)}</td>
                      <td style={{ padding: "8px 12px" }}>
                        {run.commit ? <a href={commitHref(run.commit)} target="_blank" rel="noreferrer" onClick={(e: Event) => e.stopPropagation()} style={{ color: T.blue, textDecoration: "none", fontFamily: T.fontMono, fontSize: "0.75rem" }}>{run.commit.slice(0, 7)}</a> : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}
