import { useState } from "preact/hooks";
import type { ComparisonEntry } from "@benchkit/format";
import {
  formatDirection,
  formatFixedValue,
  formatPct,
} from "../format-utils.js";

export interface ComparisonSummaryTableProps {
  entries: ComparisonEntry[];
  /** Called when a row is clicked. Receives the entry's benchmark and metric names. */
  onSelectEntry?: (benchmark: string, metric: string) => void;
  /** Override column headers. Defaults shown in comments. */
  columnLabels?: {
    /** Default: (empty — status icon column) */
    status?: string;
    /** Default: "Name" */
    name?: string;
    /** Default: "Metric" */
    metric?: string;
    /** Default: "Baseline" */
    baseline?: string;
    /** Default: "Current" */
    current?: string;
    /** Default: "Change" */
    change?: string;
    /** Default: "Direction" */
    direction?: string;
  };
  /** Whether stable entries are initially visible. Default: false */
  defaultShowStable?: boolean;
  class?: string;
}

const STATUS_ORDER: Record<string, number> = {
  regressed: 0,
  improved: 1,
  stable: 2,
};

function statusIcon(status: string): string {
  if (status === "regressed") return "▼";
  if (status === "improved") return "▲";
  return "–";
}

export function sortBySeverity(entries: ComparisonEntry[]): ComparisonEntry[] {
  return [...entries].sort((a, b) => {
    const statusDiff = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return Math.abs(b.percentChange) - Math.abs(a.percentChange);
  });
}

export function ComparisonSummaryTable({
  entries,
  onSelectEntry,
  columnLabels: cols,
  defaultShowStable = false,
  class: className,
}: ComparisonSummaryTableProps) {
  const [showStable, setShowStable] = useState(defaultShowStable);

  if (entries.length === 0) {
    return (
      <div class={["bk-empty", className].filter(Boolean).join(" ")}>
        No comparison data available.
      </div>
    );
  }

  const sorted = sortBySeverity(entries);
  const stableCount = sorted.filter((e) => e.status === "stable").length;
  const visible = showStable ? sorted : sorted.filter((e) => e.status !== "stable");

  return (
    <div class={["bk-table-shell", className].filter(Boolean).join(" ")}>
      <div class="bk-table-shell__scroll">
        <table class="bk-table">
          <caption class="bk-sr-only">Comparison results</caption>
          <thead>
            <tr>
              <th scope="col">{cols?.status ?? ""}</th>
              <th scope="col">{cols?.name ?? "Name"}</th>
              <th scope="col">{cols?.metric ?? "Metric"}</th>
              <th scope="col" class="bk-table__numeric">{cols?.baseline ?? "Baseline"}</th>
              <th scope="col" class="bk-table__numeric">{cols?.current ?? "Current"}</th>
              <th scope="col" class="bk-table__numeric">{cols?.change ?? "Change"}</th>
              <th scope="col">{cols?.direction ?? "Direction"}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr
                key={`${entry.benchmark}:${entry.metric}`}
                class={`bk-comparison-row bk-comparison-row--${entry.status}`}
                style={{
                  cursor: onSelectEntry ? "pointer" : undefined,
                }}
                tabIndex={onSelectEntry ? 0 : undefined}
                role={onSelectEntry ? "button" : undefined}
                onClick={() => onSelectEntry?.(entry.benchmark, entry.metric)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (onSelectEntry && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelectEntry(entry.benchmark, entry.metric);
                  }
                }}
              >
                <td
                  class={`bk-comparison-row__icon bk-comparison-row__icon--${entry.status}`}
                >
                  {statusIcon(entry.status)}
                </td>
                <td>{entry.benchmark}</td>
                <td>
                  <code class="bk-code">{entry.metric}</code>
                  {entry.unit && (
                    <span class="bk-muted"> ({entry.unit})</span>
                  )}
                </td>
                <td class="bk-table__numeric">{formatFixedValue(entry.baseline)}</td>
                <td class="bk-table__numeric">{formatFixedValue(entry.current)}</td>
                <td
                  class={`bk-table__numeric bk-comparison-row__change--${entry.status}`}
                >
                  {formatPct(entry.percentChange)}
                </td>
                <td class="bk-muted">{formatDirection(entry.direction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {stableCount > 0 && (
        <div class="bk-table-shell__footer">
          <button
            type="button"
            class="bk-link-button"
            onClick={() => setShowStable(!showStable)}
          >
            {showStable ? `Hide ${stableCount} stable` : `Show ${stableCount} stable`}
          </button>
        </div>
      )}
    </div>
  );
}
