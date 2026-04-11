import { useState, useEffect } from "preact/hooks";
import { fetchRunDetail } from "@benchkit/chart";
import type { RunDetailView } from "@benchkit/format";
import { T } from "../tokens";
import type { Route } from "../router";
import { DATA_SOURCE, METRIC_ICONS, fmtMetric, fmtBenchName, fmtValue } from "../constants";
import { Breadcrumb, StatPill, Card, SectionHeading, EmptyState } from "../components/ui";

export function RunDetailPage(props: {
  id: string;
  go: (r: Route) => void;
}) {
  const { id, go } = props;
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    fetchRunDetail(DATA_SOURCE, id, ctrl.signal)
      .then((d) => { if (!ctrl.signal.aborted) { setDetail(d); setDetailLoading(false); } })
      .catch((e) => { if (!ctrl.signal.aborted) { setDetailError(String(e)); setDetailLoading(false); } });
    return () => ctrl.abort();
  }, [id]);

  if (detailLoading) return <EmptyState title="Loading run detail…" body={`Fetching data for ${id}.`} />;
  if (detailError) return <EmptyState title="Error loading run" body={detailError} />;
  if (!detail) return <EmptyState title="Run not found" body={`No detail data for "${id}".`} />;

  const userSnapshots = (detail.metricSnapshots ?? []).filter((s) => !s.metric.startsWith("_monitor"));
  const monitorSnapshots = (detail.metricSnapshots ?? []).filter((s) => s.metric.startsWith("_monitor"));
  const commitShort = detail.run.commit?.slice(0, 7);
  const refShort = (detail.run.ref ?? "").replace("refs/heads/", "").replace("refs/pull/", "PR #").replace("/merge", "");
  const monitor = detail.run.monitor;

  return (
    <div style={{ display: "grid", gap: "32px" }}>
      <Breadcrumb
        items={[
          { label: "Benchmarks", route: { page: "benchmarks" } },
          { label: `Run ${id}` },
        ]}
        go={go}
      />

      <div>
        <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700, color: T.textPrimary, fontFamily: T.fontMono }}>{id}</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
          <StatPill label="Time" value={new Date(detail.run.timestamp).toLocaleString()} />
          {commitShort && <StatPill label="Commit" value={commitShort} color={T.blue} />}
          {refShort && <StatPill label="Ref" value={refShort} color={T.green} />}
          {detail.run.benchmarks !== undefined && <StatPill label="Benchmarks" value={detail.run.benchmarks} color={T.purple} />}
        </div>
      </div>

      {/* Runner context */}
      {monitor && (
        <section>
          <SectionHeading title="Runner environment" />
          <Card>
            <div style={{ display: "grid", gap: "8px", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", fontSize: "0.8rem" }}>
              {monitor.runner_os && <div><span style={{ color: T.textSecondary }}>OS: </span><span style={{ fontWeight: 600 }}>{monitor.runner_os}</span></div>}
              {monitor.runner_arch && <div><span style={{ color: T.textSecondary }}>Arch: </span><span style={{ fontWeight: 600 }}>{monitor.runner_arch}</span></div>}
              {monitor.cpu_model && <div><span style={{ color: T.textSecondary }}>CPU: </span><span style={{ fontWeight: 600 }}>{monitor.cpu_model}</span></div>}
              {monitor.cpu_count !== undefined && <div><span style={{ color: T.textSecondary }}>Cores: </span><span style={{ fontWeight: 600 }}>{monitor.cpu_count}</span></div>}
              {monitor.total_memory_mb !== undefined && <div><span style={{ color: T.textSecondary }}>Memory: </span><span style={{ fontWeight: 600 }}>{(monitor.total_memory_mb / 1024).toFixed(1)} GB</span></div>}
              {monitor.duration_ms !== undefined && <div><span style={{ color: T.textSecondary }}>Duration: </span><span style={{ fontWeight: 600 }}>{(monitor.duration_ms / 1000).toFixed(1)}s</span></div>}
            </div>
          </Card>
        </section>
      )}

      {/* Benchmark results */}
      {userSnapshots.length > 0 && (
        <section>
          <SectionHeading title="Benchmark results" subtitle={`${userSnapshots.length} metric${userSnapshots.length === 1 ? "" : "s"} captured.`} />
          {userSnapshots.map((snapshot, si) => (
            <div key={snapshot.metric} style={{ marginBottom: si < userSnapshots.length - 1 ? "16px" : "0" }}>
              <Card>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                      {METRIC_ICONS[snapshot.metric] ?? "📈"} {fmtMetric(snapshot.metric)}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: T.textMuted }}>
                      {snapshot.unit ?? ""} · {snapshot.direction === "bigger_is_better" ? "↑ Higher is better" : "↓ Lower is better"}
                    </div>
                  </div>
                  <button
                    onClick={() => go({ page: "metric", name: snapshot.metric })}
                    style={{ border: `1px solid ${T.border}`, background: T.bgCard, borderRadius: "6px", padding: "4px 12px", cursor: "pointer", fontSize: "0.72rem", fontWeight: 600, color: T.blue, fontFamily: T.font }}
                  >
                    History →
                  </button>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                    <thead>
                      <tr style={{ borderBottom: `2px solid ${T.border}`, textAlign: "left" as const }}>
                        <th style={{ padding: "6px 12px", fontWeight: 600, color: T.textSecondary }}>Benchmark</th>
                        <th style={{ padding: "6px 12px", fontWeight: 600, color: T.textSecondary, textAlign: "right" as const }}>Value</th>
                        {snapshot.values?.some((v) => v.range !== undefined) && (
                          <th style={{ padding: "6px 12px", fontWeight: 600, color: T.textSecondary, textAlign: "right" as const }}>± Range</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {(snapshot.values ?? []).map((val) => (
                        <tr
                          key={val.name}
                          onClick={() => go({ page: "benchmark", name: val.name })}
                          style={{ borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer" }}
                        >
                          <td style={{ padding: "6px 12px", fontWeight: 600 }}>{fmtBenchName(val.name)}</td>
                          <td style={{ padding: "6px 12px", textAlign: "right" as const, fontFamily: T.fontMono, fontWeight: 700 }}>
                            {fmtValue(val.value, snapshot.metric)} <span style={{ fontWeight: 400, color: T.textMuted }}>{snapshot.unit ?? ""}</span>
                          </td>
                          {snapshot.values?.some((v) => v.range !== undefined) && (
                            <td style={{ padding: "6px 12px", textAlign: "right" as const, color: T.textMuted, fontFamily: T.fontMono }}>
                              {val.range !== undefined ? `±${val.range}` : "–"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ))}
        </section>
      )}

      {/* Monitor snapshots */}
      {monitorSnapshots.length > 0 && (
        <details style={{ marginTop: "8px" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, color: T.textSecondary, padding: "8px 0" }}>
            Runner telemetry ({monitorSnapshots.length} monitor metric{monitorSnapshots.length === 1 ? "" : "s"})
          </summary>
          {monitorSnapshots.map((snapshot) => (
            <Card key={snapshot.metric} style={{ marginTop: "8px" }}>
              <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "8px" }}>{snapshot.metric.replace("_monitor/", "")}</div>
              <div style={{ fontSize: "0.8rem", color: T.textSecondary }}>
                {(snapshot.values ?? []).map((v) => `${v.name}: ${fmtValue(v.value)}`).join(", ")}
              </div>
            </Card>
          ))}
        </details>
      )}
    </div>
  );
}
