import type { IndexFile, RunEntry } from "@benchkit/format";
import type { DashboardLabels } from "../dashboard-labels.js";
import { formatRef } from "../format-utils.js";

export interface RunTableProps {
  index: IndexFile;
  maxRows?: number;
  onSelectRun?: (runId: string) => void;
  /** Link commits to GitHub or other VCS */
  commitHref?: (commit: string, run: RunEntry) => string | undefined;
  class?: string;
  labels?: DashboardLabels;
}

export function RunTable({ index, maxRows, onSelectRun, commitHref, class: className, labels }: RunTableProps) {
  const runs = maxRows ? index.runs.slice(0, maxRows) : index.runs;

  return (
    <div class={["bk-table-shell", className].filter(Boolean).join(" ")}>
      <div class="bk-table-shell__scroll">
        <table class="bk-table">
          <caption class="bk-sr-only">Recent benchmark runs</caption>
          <thead>
            <tr>
              <th scope="col">{labels?.runColumn ?? "Run"}</th>
              <th scope="col">{labels?.timeColumn ?? "Time"}</th>
              <th scope="col">{labels?.commitColumn ?? "Commit"}</th>
              <th scope="col">{labels?.refColumn ?? "Ref"}</th>
              <th scope="col" class="bk-table__numeric">{labels?.benchmarksColumn ?? "Benchmarks"}</th>
              <th scope="col">{labels?.metricsColumn ?? "Metrics"}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                style={{ cursor: onSelectRun ? "pointer" : "default" }}
                onClick={() => onSelectRun?.(run.id)}
              >
                <td>
                  <code class="bk-code">{run.id}</code>
                </td>
                <td>{formatTime(run.timestamp)}</td>
                <td>
                  {run.commit ? (
                    (() => {
                      const href = commitHref?.(run.commit, run);
                      const code = <code class="bk-code">{run.commit.slice(0, 8)}</code>;
                      return href ? <a href={href} target="_blank" rel="noopener noreferrer">{code}</a> : code;
                    })()
                  ) : (
                    <span class="bk-muted">—</span>
                  )}
                </td>
                <td>{formatRef(run.ref)}</td>
                <td class="bk-table__numeric">{run.benchmarks ?? "—"}</td>
                <td class="bk-muted">{run.metrics?.join(", ") ?? "—"}</td>
              </tr>
            ))}
          </tbody>
          {maxRows && index.runs.length > maxRows && (
            <tfoot>
              <tr>
                <td colSpan={6} class="bk-muted">
                  Showing {maxRows} of {index.runs.length} runs
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}
