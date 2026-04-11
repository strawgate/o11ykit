import { useState, useEffect, useMemo } from "preact/hooks";
import type {
  RunDetailView,
  RunDetailMetricSnapshot,
  ComparisonResult,
  MonitorContext,
} from "@benchkit/format";
import { fetchRunDetail, type DataSource } from "./fetch.js";
import { formatRef, formatTimestamp, formatValue } from "./format-utils.js";
import { VerdictBanner } from "./components/VerdictBanner.js";
import { ComparisonSummaryTable } from "./components/ComparisonSummaryTable.js";
import { defaultMetricLabel, isMonitorMetric } from "./labels.js";
import { partitionSnapshots } from "./dataset-transforms.js";

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface RunDetailProps {
  /** Preloaded run detail. If provided, no fetch is performed. */
  detail?: RunDetailView;
  /** Data source + run ID for on-demand fetching (ignored when `detail` is set). */
  source?: DataSource;
  runId?: string;
  /** Optional comparison result to show a verdict banner + comparison table. */
  comparison?: ComparisonResult | null;
  /** Labels for comparison context. */
  currentLabel?: string;
  baselineLabel?: string;
  /** Build a link for a commit hash. */
  commitHref?: (commit: string) => string | undefined;
  /** Custom metric label renderer. */
  metricLabelFormatter?: (metric: string) => string;
  class?: string;
}

export interface MetricSnapshotCardProps {
  snapshot: RunDetailMetricSnapshot;
  formatMetric: (m: string) => string;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function RunMetadataBar({ run, commitHref }: { run: RunDetailView["run"]; commitHref?: RunDetailProps["commitHref"] }) {
  const commitShort = run.commit?.slice(0, 8);
  const commitEl = commitShort
    ? (() => {
        const href = commitHref?.(run.commit!);
        const code = <code class="bk-code">{commitShort}</code>;
        return href ? <a href={href} target="_blank" rel="noopener noreferrer">{code}</a> : code;
      })()
    : null;

  return (
    <div class="bk-run-meta">
      <div class="bk-run-meta__row">
        <span class="bk-run-meta__item">
          <strong>Run:</strong> <code class="bk-code">{run.id}</code>
        </span>
        <span class="bk-run-meta__item">
          <strong>Time:</strong> {formatTimestamp(run.timestamp)}
        </span>
        {commitEl && (
          <span class="bk-run-meta__item">
            <strong>Commit:</strong> {commitEl}
          </span>
        )}
        {run.ref && (
          <span class="bk-run-meta__item">
            <strong>Ref:</strong> {formatRef(run.ref)}
          </span>
        )}
        {run.benchmarks !== null && run.benchmarks !== undefined && (
          <span class="bk-run-meta__item">
            <strong>Benchmarks:</strong> {run.benchmarks}
          </span>
        )}
        {run.metrics && (
          <span class="bk-run-meta__item">
            <strong>Metrics:</strong> {run.metrics.length}
          </span>
        )}
      </div>
    </div>
  );
}

function RunnerContextPanel({ ctx }: { ctx: MonitorContext }) {
  const items: Array<[string, string]> = [];
  if (ctx.runner_os) items.push(["OS", ctx.runner_arch ? `${ctx.runner_os} (${ctx.runner_arch})` : ctx.runner_os]);
  if (ctx.kernel) items.push(["Kernel", ctx.kernel]);
  if (ctx.cpu_model) items.push(["CPU", ctx.cpu_count ? `${ctx.cpu_model} × ${ctx.cpu_count}` : ctx.cpu_model]);
  if (ctx.total_memory_mb !== null && ctx.total_memory_mb !== undefined) items.push(["Memory", `${Math.round(ctx.total_memory_mb / 1024)} GB`]);
  if (ctx.poll_interval_ms) items.push(["Poll interval", `${ctx.poll_interval_ms} ms`]);
  if (ctx.duration_ms) items.push(["Duration", `${(ctx.duration_ms / 1000).toFixed(1)} s`]);

  if (items.length === 0) return null;

  return (
    <details class="bk-runner-panel" open>
      <summary class="bk-runner-panel__title">Runner environment</summary>
      <div class="bk-runner-panel__grid">
        {items.map(([label, value]) => (
          <span key={label} class="bk-runner-panel__item">
            <strong>{label}:</strong> {value}
          </span>
        ))}
      </div>
    </details>
  );
}

export function MetricSnapshotCard({ snapshot, formatMetric }: MetricSnapshotCardProps) {
  const label = formatMetric(snapshot.metric);
  const unitSuffix = snapshot.unit ? ` (${snapshot.unit})` : "";
  const dirLabel = snapshot.direction === "bigger_is_better" ? "↑ higher is better" : snapshot.direction === "smaller_is_better" ? "↓ lower is better" : "";

  return (
    <div class="bk-card bk-metric-snap">
      <div class="bk-card__top">
        <div>
          <h4 class="bk-card__title">{label}{unitSuffix}</h4>
          {dirLabel && <p class="bk-card__hint">{dirLabel}</p>}
        </div>
        <span class="bk-badge bk-badge--muted">{snapshot.values.length} series</span>
      </div>
      <div class="bk-metric-snap__values">
        {snapshot.values.map((v) => {
          const unit = v.unit ?? snapshot.unit;
          return (
            <div key={`${v.name}-${snapshot.metric}`} class="bk-metric-snap__row">
              <span class="bk-metric-snap__name">{v.name}</span>
              <span class="bk-metric-snap__value">
                {formatValue(v.value)}{unit ? ` ${unit}` : ""}
                {v.range !== null && v.range !== undefined && <span class="bk-muted"> ± {formatValue(v.range)}{unit ? ` ${unit}` : ""}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main RunDetail component                                           */
/* ------------------------------------------------------------------ */

export function RunDetail({
  detail: preloaded,
  source,
  runId,
  comparison,
  currentLabel,
  baselineLabel,
  commitHref,
  metricLabelFormatter,
  class: className,
}: RunDetailProps) {
  const [detail, setDetail] = useState<RunDetailView | null>(preloaded ?? null);
  const [loading, setLoading] = useState(!preloaded && !!runId);
  const [error, setError] = useState<string | null>(null);

  // Fetch on demand when no preloaded detail is provided.
  useEffect(() => {
    if (preloaded) {
      setDetail(preloaded);
      setLoading(false);
      setError(null);
      return;
    }
    if (!source || !runId) return;

    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    fetchRunDetail(source, runId, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) {
          setDetail(d);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setError(`Failed to load run: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    return () => ctrl.abort();
  }, [preloaded, source, runId]);

  const formatMetric = metricLabelFormatter ?? defaultMetricLabel;

  // Partition metric snapshots into user metrics and monitor metrics.
  const [monitorSnapshots, userSnapshots] = useMemo(
    () => detail ? partitionSnapshots(detail.metricSnapshots, isMonitorMetric) : [[], []],
    [detail],
  );

  const rootClassName = ["bk-run-detail", className].filter(Boolean).join(" ");

  if (loading) {
    return (
      <div class={rootClassName}>
        <div class="bk-loading">
          <h2 class="bk-loading__title">Loading run details…</h2>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class={rootClassName}>
        <div class="bk-state">
          <h2 class="bk-state__title">Error</h2>
          <p class="bk-state__body">{error}</p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div class={rootClassName}>
        <div class="bk-state">
          <h2 class="bk-state__title">No run data</h2>
          <p class="bk-state__body">Provide either a preloaded detail object or a source + runId.</p>
        </div>
      </div>
    );
  }

  return (
    <div class={rootClassName}>
      <RunMetadataBar run={detail.run} commitHref={commitHref} />

      {detail.run.monitor && <RunnerContextPanel ctx={detail.run.monitor} />}

      {comparison && (
        <section class="bk-section">
          <VerdictBanner
            result={comparison}
            currentLabel={currentLabel}
            baselineLabel={baselineLabel}
          />
          <ComparisonSummaryTable entries={comparison.entries} />
        </section>
      )}

      {userSnapshots.length > 0 && (
        <section class="bk-section">
          <div class="bk-section__header">
            <div>
              <h3 class="bk-section__title">Metric snapshots</h3>
              <p class="bk-section__description">{userSnapshots.length} metrics recorded in this run.</p>
            </div>
          </div>
          <div class="bk-overview-grid">
            {userSnapshots.map((s) => (
              <MetricSnapshotCard key={s.metric} snapshot={s} formatMetric={formatMetric} />
            ))}
          </div>
        </section>
      )}

      {monitorSnapshots.length > 0 && (
        <details class="bk-section" open={!userSnapshots.length}>
          <summary class="bk-section__title bk-section__title--collapsible">
            Runner metrics ({monitorSnapshots.length})
          </summary>
          <div class="bk-overview-grid">
            {monitorSnapshots.map((s) => (
              <MetricSnapshotCard key={s.metric} snapshot={s} formatMetric={formatMetric} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
