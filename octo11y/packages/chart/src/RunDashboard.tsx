import { useState, useEffect, useCallback } from "preact/hooks";
import type {
  IndexFile,
  PrIndexEntry,
  RefIndexEntry,
  ComparisonResult,
  RunDetailView,
} from "@benchkit/format";
import {
  fetchIndex,
  fetchPrIndex,
  fetchRefIndex,
  fetchRunDetail,
  compareRuns,
  type DataSource,
} from "./fetch.js";
import { RunSelector } from "./components/RunSelector.js";
import { VerdictBanner } from "./components/VerdictBanner.js";
import { ComparisonSummaryTable } from "./components/ComparisonSummaryTable.js";
import { formatRef } from "./format-utils.js";

export interface RunDashboardProps {
  source: DataSource;
  /** Branch used for baseline resolution. Default: "main" */
  defaultBranch?: string;
  /** Percentage change threshold for regressions. Default: 5 */
  regressionThreshold?: number;
  /** Link builder for commit hashes */
  commitHref?: (commit: string) => string | undefined;
  /** Custom metric label renderer */
  metricLabelFormatter?: (metric: string) => string;
  class?: string;
}

/** Resolved baseline from refIndex or direct run. */
export function resolveBaseline(
  refIndex: RefIndexEntry[],
  defaultBranch: string,
): string | null {
  const fullRef = `refs/heads/${defaultBranch}`;
  const match = refIndex.find((r) => r.ref === fullRef);
  return match?.latestRunId ?? null;
}

/** Auto-select the latest run: first PR, or first ref, or first index run. */
export function autoSelectRun(
  prIndex?: PrIndexEntry[],
  refIndex?: RefIndexEntry[],
  index?: IndexFile,
): string | null {
  if (prIndex && prIndex.length > 0) {
    const sorted = [...prIndex].sort((a, b) =>
      b.latestTimestamp.localeCompare(a.latestTimestamp),
    );
    return sorted[0].latestRunId;
  }
  if (refIndex && refIndex.length > 0) {
    const sorted = [...refIndex].sort((a, b) =>
      b.latestTimestamp.localeCompare(a.latestTimestamp),
    );
    return sorted[0].latestRunId;
  }
  if (index && index.runs.length > 0) {
    return index.runs[0].id;
  }
  return null;
}

interface DashboardState {
  index: IndexFile | null;
  prIndex: PrIndexEntry[];
  refIndex: RefIndexEntry[];
  selectedRunId: string | null;
  baselineRunId: string | null;
  comparison: ComparisonResult | null;
  currentDetail: RunDetailView | null;
  baselineDetail: RunDetailView | null;
  loading: boolean;
  error: string | null;
  focusedEntry: { benchmark: string; metric: string } | null;
}

const INITIAL_STATE: DashboardState = {
  index: null,
  prIndex: [],
  refIndex: [],
  selectedRunId: null,
  baselineRunId: null,
  comparison: null,
  currentDetail: null,
  baselineDetail: null,
  loading: true,
  error: null,
  focusedEntry: null,
};

export function RunDashboard({
  source,
  defaultBranch = "main",
  regressionThreshold = 5,
  commitHref: _commitHref,
  metricLabelFormatter,
  class: className,
}: RunDashboardProps) {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);

  // Phase 1: Load indices
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));

    Promise.all([
      fetchIndex(source, ctrl.signal),
      fetchPrIndex(source, ctrl.signal).catch(() => [] as PrIndexEntry[]),
      fetchRefIndex(source, ctrl.signal).catch(() => [] as RefIndexEntry[]),
    ])
      .then(([index, prIndex, refIndex]) => {
        const selectedRunId = autoSelectRun(prIndex, refIndex, index);
        const baselineRunId = resolveBaseline(refIndex, defaultBranch);
        setState((s) => ({
          ...s,
          index,
          prIndex,
          refIndex,
          selectedRunId,
          baselineRunId,
          loading: !selectedRunId,
          error: selectedRunId ? null : "No runs available.",
        }));
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) {
          setState((s) => ({
            ...s,
            loading: false,
            error: `Failed to load index: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      });

    return () => ctrl.abort();
  }, [source, defaultBranch]);

  // Phase 2: Load run details and compare
  useEffect(() => {
    const { selectedRunId, baselineRunId } = state;
    if (!selectedRunId) return;

    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, comparison: null, focusedEntry: null }));

    const hasBaseline = baselineRunId && baselineRunId !== selectedRunId;

    if (hasBaseline) {
      compareRuns(source, selectedRunId, baselineRunId, {
        test: "percentage",
        threshold: regressionThreshold,
      }, ctrl.signal)
        .then(({ comparison, currentDetail, baselineDetail }) => {
          setState((s) => ({
            ...s,
            currentDetail,
            baselineDetail,
            comparison,
            loading: false,
            error: null,
          }));
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) {
            setState((s) => ({
              ...s,
              loading: false,
              error: `Failed to load run details: ${err instanceof Error ? err.message : String(err)}`,
            }));
          }
        });
    } else {
      fetchRunDetail(source, selectedRunId, ctrl.signal)
        .then((currentDetail) => {
          setState((s) => ({
            ...s,
            currentDetail,
            baselineDetail: null,
            comparison: null,
            loading: false,
            error: null,
          }));
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) {
            setState((s) => ({
              ...s,
              loading: false,
              error: `Failed to load run detail: ${err instanceof Error ? err.message : String(err)}`,
            }));
          }
        });
    }

    return () => ctrl.abort();
  }, [state.selectedRunId, state.baselineRunId, source, regressionThreshold]);

  const onSelectRun = useCallback(
    (runId: string) => setState((s) => ({ ...s, selectedRunId: runId })),
    [],
  );
  const onSelectBaseline = useCallback(
    (runId: string) => setState((s) => ({ ...s, baselineRunId: runId })),
    [],
  );
  const onSelectEntry = useCallback(
    (benchmark: string, metric: string) =>
      setState((s) => ({
        ...s,
        focusedEntry:
          s.focusedEntry?.benchmark === benchmark &&
          s.focusedEntry?.metric === metric
            ? null
            : { benchmark, metric },
      })),
    [],
  );

  const { index, prIndex, refIndex, comparison, loading, error, focusedEntry } =
    state;

  const metricLabel = metricLabelFormatter ?? ((m: string) => m);
  const currentRun = index?.runs.find((r) => r.id === state.selectedRunId);
  const baselineRun = index?.runs.find((r) => r.id === state.baselineRunId);

  return (
    <div class={["bk-run-dashboard", className].filter(Boolean).join(" ")}>
      {/* Run selector */}
      {index && (
        <RunSelector
          prIndex={prIndex}
          refIndex={refIndex}
          index={index}
          selectedRunId={state.selectedRunId ?? undefined}
          baselineRunId={state.baselineRunId ?? undefined}
          onSelectRun={onSelectRun}
          onSelectBaseline={onSelectBaseline}
        />
      )}

      {/* Loading state */}
      {loading && (
        <div class="bk-run-dashboard__status">Loading run data…</div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div class="bk-run-dashboard__status bk-run-dashboard__status--error">
          {error}
        </div>
      )}

      {/* No baseline info */}
      {!loading &&
        !error &&
        !state.baselineRunId &&
        state.selectedRunId && (
          <div class="bk-run-dashboard__status bk-run-dashboard__status--info">
            No baseline run found on <code>{defaultBranch}</code>. Select a
            baseline manually using "set baseline" on any run.
          </div>
        )}

      {/* Comparison results */}
      {!loading && comparison && (
        <>
          <VerdictBanner
            result={comparison}
            currentLabel={runLabel(currentRun)}
            baselineLabel={runLabel(baselineRun)}
          />

          <ComparisonSummaryTable
            entries={comparison.entries}
            onSelectEntry={onSelectEntry}
          />

          {/* Focused metric detail */}
          {focusedEntry && (
            <FocusedMetricPanel
              entry={focusedEntry}
              comparison={comparison}
              metricLabel={metricLabel}
            />
          )}
        </>
      )}

      {/* Selected run with no comparison (no baseline) */}
      {!loading && !comparison && state.currentDetail && (
        <div class="bk-run-dashboard__status bk-run-dashboard__status--info">
          Showing run <strong>{state.selectedRunId}</strong> —{" "}
          {state.currentDetail.metricSnapshots.length} metrics recorded. Select
          a baseline to compare.
        </div>
      )}
    </div>
  );
}

/** Short label for a run (commit + ref). */
function runLabel(run?: { id: string; commit?: string; ref?: string }): string {
  if (!run) return "unknown";
  const ref = run.ref ? formatRef(run.ref) : undefined;
  const commit = run.commit?.slice(0, 7);
  if (ref && ref !== "—" && commit) return `${ref} (${commit})`;
  if (ref && ref !== "—") return ref;
  if (commit) return commit;
  return run.id.slice(0, 12);
}

/** Renders a ComparisonChart for the focused metric entry. */
function FocusedMetricPanel({
  entry,
  comparison,
  metricLabel,
}: {
  entry: { benchmark: string; metric: string };
  comparison: ComparisonResult;
  metricLabel: (m: string) => string;
}) {
  const match = comparison.entries.find(
    (e) => e.benchmark === entry.benchmark && e.metric === entry.metric,
  );
  if (!match) return null;

  return (
    <div class="bk-run-dashboard__detail">
      <h3 class="bk-run-dashboard__detail-title">
        {entry.benchmark} — {metricLabel(entry.metric)}
      </h3>
      <p class="bk-run-dashboard__detail-summary">
        Baseline: <strong>{match.baseline}</strong> → Current:{" "}
        <strong>{match.current}</strong> ({match.percentChange > 0 ? "+" : ""}
        {match.percentChange.toFixed(2)}%)
      </p>
    </div>
  );
}
