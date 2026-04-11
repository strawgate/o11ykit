import { useMemo } from "preact/hooks";
import { TrendChart, ComparisonBar, Leaderboard, detectRegressions } from "@benchkit/chart";
import type { SeriesFile } from "@benchkit/format";
import { T } from "../tokens";
import { ACCENT_COLORS } from "../tokens";
import type { Route } from "../router";
import { METRIC_ICONS, fmtMetric, fmtBenchName, fmtSeriesName, fmtValue } from "../constants";
import type { BenchData } from "../hooks/use-bench-data";
import { Breadcrumb, StatPill, Card, SectionHeading, EmptyState } from "../components/ui";

export function MetricDetailPage(props: {
  name: string;
  data: BenchData;
  go: (r: Route) => void;
}) {
  const { name, data, go } = props;
  const sf = data.seriesMap.get(name);

  if (data.loading) return <EmptyState title="Loading…" body="" />;
  if (!sf) return <EmptyState title="Metric not found" body={`No data for "${name}".`} />;

  const seriesNames = Object.keys(sf.series);
  const regressions = useMemo(() => detectRegressions(sf, 10, 5), [sf]);

  return (
    <div style={{ display: "grid", gap: "32px" }}>
      <Breadcrumb
        items={[
          { label: "Benchmarks", route: { page: "benchmarks" } },
          { label: `${METRIC_ICONS[name] ?? "📈"} ${fmtMetric(name)}` },
        ]}
        go={go}
      />

      <div>
        <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 700, color: T.textPrimary }}>
          {METRIC_ICONS[name] ?? "📈"} {fmtMetric(name)}
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
          <StatPill label="Unit" value={sf.unit ?? "–"} />
          <StatPill label="Direction" value={sf.direction === "bigger_is_better" ? "↑ Higher is better" : "↓ Lower is better"} color={sf.direction === "bigger_is_better" ? T.green : T.blue} />
          <StatPill label="Series" value={seriesNames.length} color={T.purple} />
          {regressions.length > 0 && <StatPill label="Regressions" value={regressions.length} color={T.red} />}
        </div>
      </div>

      {/* Trend chart - all series overlaid */}
      <section>
        <SectionHeading title="Trend" subtitle="All benchmarks for this metric over time." />
        <Card>
          <TrendChart
            series={sf}
            height={300}
            maxPoints={50}
            seriesNameFormatter={fmtSeriesName}
            regressions={regressions}
          />
        </Card>
      </section>

      {/* Comparison bar */}
      {seriesNames.length > 1 && (
        <section>
          <SectionHeading title="Latest comparison" subtitle="Most recent value for each benchmark." />
          <Card>
            <ComparisonBar
              series={sf}
              height={Math.max(200, seriesNames.length * 50)}
              seriesNameFormatter={fmtSeriesName}
            />
          </Card>
        </section>
      )}

      {/* Leaderboard */}
      {seriesNames.length > 1 && (
        <section>
          <SectionHeading title="Leaderboard" subtitle="Ranking by latest value." />
          <Card>
            <Leaderboard
              series={sf}
              seriesNameFormatter={fmtSeriesName}
            />
          </Card>
        </section>
      )}

      {/* Per-benchmark cards */}
      <section>
        <SectionHeading title="By benchmark" subtitle="Click to see full benchmark detail." />
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {seriesNames.map((sn, i) => {
            const entry = sf.series[sn];
            const latest = entry.points?.slice(-1)[0];
            const singleSeries: SeriesFile = { metric: sf.metric, unit: sf.unit, direction: sf.direction, series: { [sn]: entry } };
            const reg = regressions.filter((r) => r.seriesName === sn);
            return (
              <Card key={sn} onClick={() => go({ page: "benchmark", name: sn })} borderColor={ACCENT_COLORS[i % ACCENT_COLORS.length]}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{fmtBenchName(sn)}</div>
                  {reg.length > 0 && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: T.red, background: "rgba(248,81,73,0.1)", borderRadius: "4px", padding: "2px 6px" }}>Regression</span>}
                </div>
                <div style={{ fontSize: "1.5rem", fontWeight: 700, color: T.textPrimary, marginBottom: "4px" }}>
                  {latest ? fmtValue(latest.value, name) : "–"}
                  <span style={{ fontSize: "0.75rem", fontWeight: 400, color: T.textMuted, marginLeft: "4px" }}>{sf.unit ?? ""}</span>
                </div>
                <TrendChart
                  series={singleSeries}
                  height={80}
                  maxPoints={20}
                  compact={true}
                  showLegend={false}
                  showSeriesCount={false}
                  seriesNameFormatter={fmtSeriesName}
                  regressions={reg}
                />
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
