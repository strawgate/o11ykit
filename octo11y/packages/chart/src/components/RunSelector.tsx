import type {
  IndexFile,
  PrIndexEntry,
  RefIndexEntry,
} from "@benchkit/format";
import {
  formatRef as defaultFormatRef,
  formatTimestamp,
  shortCommit,
} from "../format-utils.js";

/** Maximum number of recent runs shown in ref-fallback mode. */
const MAX_RECENT_RUNS = 20;

export interface RunSelectorProps {
  prIndex?: PrIndexEntry[];
  refIndex?: RefIndexEntry[];
  index: IndexFile;
  selectedRunId?: string;
  baselineRunId?: string;
  onSelectRun: (runId: string) => void;
  /** Called when the user picks a baseline. If omitted, baseline is display-only. */
  onSelectBaseline?: (runId: string) => void;
  /** Label for the PR list heading. Default: "Pull Requests" */
  prHeading?: string;
  /** Label for the ref/run list heading. Default: "Runs" */
  runHeading?: string;
  /** Custom ref formatter. Default: {@link formatRef} from format-utils. */
  formatRef?: (ref: string) => string;
  class?: string;
}

export function RunSelector({
  prIndex,
  refIndex,
  index,
  selectedRunId,
  baselineRunId,
  onSelectRun,
  onSelectBaseline,
  prHeading = "Pull Requests",
  runHeading = "Runs",
  formatRef = defaultFormatRef,
  class: className,
}: RunSelectorProps) {
  const hasPrs = prIndex && prIndex.length > 0;
  const sortedPrs = hasPrs
    ? [...prIndex!].sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp))
    : undefined;

  return (
    <div class={["bk-run-selector", className].filter(Boolean).join(" ")}>
      {hasPrs ? (
        <PrList
          prIndex={sortedPrs!}
          selectedRunId={selectedRunId}
          baselineRunId={baselineRunId}
          onSelectRun={onSelectRun}
          onSelectBaseline={onSelectBaseline}
          heading={prHeading}
        />
      ) : (
        <RefList
          refIndex={refIndex}
          index={index}
          selectedRunId={selectedRunId}
          baselineRunId={baselineRunId}
          onSelectRun={onSelectRun}
          onSelectBaseline={onSelectBaseline}
          heading={runHeading}
          formatRef={formatRef}
        />
      )}
    </div>
  );
}

interface PrListProps {
  prIndex: PrIndexEntry[];
  selectedRunId?: string;
  baselineRunId?: string;
  onSelectRun: (runId: string) => void;
  onSelectBaseline?: (runId: string) => void;
  heading: string;
}

function PrList({
  prIndex,
  selectedRunId,
  baselineRunId,
  onSelectRun,
  onSelectBaseline,
  heading,
}: PrListProps) {
  return (
    <div class="bk-run-selector__list">
      <div class="bk-run-selector__heading">{heading}</div>
      {prIndex.map((pr) => {
        const isSelected = pr.latestRunId === selectedRunId;
        const isBaseline = pr.latestRunId === baselineRunId;
        return (
          <button
            key={pr.prNumber}
            class={[
              "bk-run-selector__item",
              isSelected && "bk-run-selector__item--selected",
              isBaseline && "bk-run-selector__item--baseline",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSelectRun(pr.latestRunId)}
            type="button"
          >
            <span class="bk-run-selector__primary">PR #{pr.prNumber}</span>
            <span class="bk-run-selector__meta">
              <code class="bk-code">{shortCommit(pr.latestCommit)}</code>
              {" · "}
              {formatTimestamp(pr.latestTimestamp)}
              {pr.runCount > 1 && (
                <span class="bk-muted"> · {pr.runCount} runs</span>
              )}
            </span>
            {isSelected && <span class="bk-badge bk-badge--accent">selected</span>}
            {isBaseline && <span class="bk-badge bk-badge--muted">baseline</span>}
            {onSelectBaseline && !isBaseline && (
              <button
                type="button"
                class="bk-link-button bk-run-selector__baseline-btn"
                onClick={(e: Event) => { e.stopPropagation(); onSelectBaseline(pr.latestRunId); }}
              >
                set baseline
              </button>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface RefListProps {
  refIndex?: RefIndexEntry[];
  index: IndexFile;
  selectedRunId?: string;
  baselineRunId?: string;
  onSelectRun: (runId: string) => void;
  onSelectBaseline?: (runId: string) => void;
  heading: string;
  formatRef: (ref: string) => string;
}

function RefList({
  refIndex,
  index,
  selectedRunId,
  baselineRunId,
  onSelectRun,
  onSelectBaseline,
  heading,
  formatRef,
}: RefListProps) {
  const items = refIndex && refIndex.length > 0
    ? refIndex.map((r) => ({
        id: r.latestRunId,
        label: formatRef(r.ref),
        commit: r.latestCommit,
        timestamp: r.latestTimestamp,
        runCount: r.runCount,
      }))
    : index.runs.slice(0, MAX_RECENT_RUNS).map((r) => ({
        id: r.id,
        label: r.ref ? formatRef(r.ref) : r.id,
        commit: r.commit,
        timestamp: r.timestamp,
        runCount: 1,
      }));

  return (
    <div class="bk-run-selector__list">
      <div class="bk-run-selector__heading">{heading}</div>
      {items.map((item) => {
        const isSelected = item.id === selectedRunId;
        const isBaseline = item.id === baselineRunId;
        return (
          <button
            key={item.id}
            class={[
              "bk-run-selector__item",
              isSelected && "bk-run-selector__item--selected",
              isBaseline && "bk-run-selector__item--baseline",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSelectRun(item.id)}
            type="button"
          >
            <span class="bk-run-selector__primary">{item.label}</span>
            <span class="bk-run-selector__meta">
              <code class="bk-code">{shortCommit(item.commit)}</code>
              {" · "}
              {formatTimestamp(item.timestamp)}
              {item.runCount > 1 && (
                <span class="bk-muted"> · {item.runCount} runs</span>
              )}
            </span>
            {isSelected && <span class="bk-badge bk-badge--accent">selected</span>}
            {isBaseline && <span class="bk-badge bk-badge--muted">baseline</span>}
            {onSelectBaseline && !isBaseline && (
              <button
                type="button"
                class="bk-link-button bk-run-selector__baseline-btn"
                onClick={(e: Event) => { e.stopPropagation(); onSelectBaseline(item.id); }}
              >
                set baseline
              </button>
            )}
          </button>
        );
      })}
      {items.length === 0 && (
        <div class="bk-empty">No runs available.</div>
      )}
    </div>
  );
}
