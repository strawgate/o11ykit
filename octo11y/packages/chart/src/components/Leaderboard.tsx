import type { SeriesFile, SeriesEntry } from "@benchkit/format";
import { rankSeries, type RankedEntry } from "../leaderboard.js";

export interface LeaderboardProps {
  series: SeriesFile;
  /** Custom series name renderer */
  seriesNameFormatter?: (name: string, entry: SeriesEntry) => string;
  class?: string;
}

function formatDelta(delta: number | undefined, unit: string | undefined): string {
  if (delta === undefined) return "—";
  const sign = delta > 0 ? "+" : "";
  const abs = Math.abs(delta);
  const formatted = abs >= 1000 || abs === 0
    ? Math.round(delta).toLocaleString("en-US")
    : delta.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${sign}${formatted} ${unit ?? ""}`.trim();
}

function deltaArrow(delta: number | undefined, direction: SeriesFile["direction"]): string {
  if (delta === undefined || delta === 0) return "−";
  const improved =
    direction === "bigger_is_better" ? delta > 0 : delta < 0;
  return improved ? "↑" : "↓";
}

function arrowColor(delta: number | undefined, direction: SeriesFile["direction"]): string {
  if (delta === undefined || delta === 0) return "#6b7280";
  const improved =
    direction === "bigger_is_better" ? delta > 0 : delta < 0;
  return improved ? "#16a34a" : "#dc2626";
}

function rankColor(entry: RankedEntry, direction: SeriesFile["direction"]): string {
  if (!direction) return "#111827";
  return entry.isWinner ? "#16a34a" : "#111827";
}

export function Leaderboard({ series, seriesNameFormatter, class: className }: LeaderboardProps) {
  const ranked = rankSeries(series);

  if (ranked.length === 0) return null;

  return (
    <div class={className}>
      <table class="bk-table">
        <caption class="bk-sr-only">Series leaderboard for {series.metric}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Series</th>
            <th scope="col" class="bk-table__numeric">Latest</th>
            <th scope="col" class="bk-table__numeric">Δ prev</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => {
            const label = seriesNameFormatter ? seriesNameFormatter(r.name, r.entry) : r.name;
            const arrow = deltaArrow(r.delta, series.direction);
            const color = arrowColor(r.delta, series.direction);
            return (
              <tr key={r.name}>
                <td style={{ color: rankColor(r, series.direction), fontWeight: r.isWinner ? 700 : 400 }}>
                  {r.rank}
                  {r.isWinner && series.direction ? (
                    <span
                      title="Winner"
                      class="bk-badge bk-badge--success"
                      style={{ marginLeft: "6px" }}
                    >
                      ★
                    </span>
                  ) : null}
                </td>
                <td>{label}</td>
                <td class="bk-table__numeric">
                  {r.latestValue} {series.unit ?? ""}
                </td>
                <td class="bk-table__numeric" style={{ color }}>
                  {arrow} {formatDelta(r.delta, series.unit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
