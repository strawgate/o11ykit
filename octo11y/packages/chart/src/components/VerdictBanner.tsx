import type { ComparisonResult } from "@benchkit/format";

export interface VerdictBannerProps {
  result: ComparisonResult;
  currentLabel?: string;
  baselineLabel?: string;
  /** Override the headline when regressions exist. Receives the count. */
  regressionHeadline?: (count: number) => string;
  /** Override the headline when no regressions exist. */
  cleanHeadline?: string;
  class?: string;
}

function defaultRegressionHeadline(count: number): string {
  return `${count} regression${count !== 1 ? "s" : ""} detected`;
}

export function VerdictBanner({
  result,
  currentLabel,
  baselineLabel,
  regressionHeadline = defaultRegressionHeadline,
  cleanHeadline = "No regressions",
  class: className,
}: VerdictBannerProps) {
  const regressed = result.entries.filter((e) => e.status === "regressed");
  const improved = result.entries.filter((e) => e.status === "improved");
  const stable = result.entries.filter((e) => e.status === "stable");

  const variant = result.hasRegression ? "danger" : "success";

  const labels = [currentLabel, baselineLabel].filter(Boolean);
  const subtitle =
    labels.length === 2
      ? `${labels[0]} vs ${labels[1]}`
      : labels.length === 1
        ? labels[0]
        : undefined;

  return (
    <div
      class={[`bk-verdict`, `bk-verdict--${variant}`, className]
        .filter(Boolean)
        .join(" ")}
      role="status"
    >
      <div class="bk-verdict__headline">
        {result.hasRegression
          ? regressionHeadline(regressed.length)
          : cleanHeadline}
      </div>
      <div class="bk-verdict__counts">
        <span class="bk-verdict__count bk-verdict__count--danger">
          {regressed.length} regressed
        </span>
        <span class="bk-verdict__count bk-verdict__count--success">
          {improved.length} improved
        </span>
        <span class="bk-verdict__count bk-verdict__count--muted">
          {stable.length} stable
        </span>
      </div>
      {subtitle && <div class="bk-verdict__subtitle">{subtitle}</div>}
    </div>
  );
}
