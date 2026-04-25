import type {
  ComparisonEntry,
  ComparisonMatrixLane,
  ComparisonResult,
  FormatComparisonMarkdownOptions,
} from "./types.js";

const DEFAULT_OPTIONS: Required<
  Pick<
    FormatComparisonMarkdownOptions,
    "currentLabel" | "baselineLabel" | "maxRegressions" | "includeDetails" | "footerHref"
  >
> = {
  currentLabel: "Current",
  baselineLabel: "Baseline",
  maxRegressions: 10,
  includeDetails: true,
  footerHref: "https://github.com/strawgate/octo11y",
};

function isMonitorEntry(entry: ComparisonEntry): boolean {
  return entry.benchmark.startsWith("_monitor/");
}

function sortAlphabetically(entries: ComparisonEntry[]): ComparisonEntry[] {
  return [...entries].sort((a, b) => {
    const laneA = a.lane ?? a.benchmark;
    const laneB = b.lane ?? b.benchmark;
    if (laneA !== laneB) return laneA.localeCompare(laneB);
    return a.metric.localeCompare(b.metric);
  });
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatValue(value: number, unit?: string): string {
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function directionArrow(entry: ComparisonEntry): string {
  if (entry.status === "stable") return "→";
  if (entry.direction === "smaller_is_better") {
    return entry.status === "regressed" ? "↑" : "↓";
  }
  return entry.status === "regressed" ? "↓" : "↑";
}

function statusLabel(entry: ComparisonEntry): string {
  return `${entry.status} ${directionArrow(entry)}`;
}

function laneLabel(entry: ComparisonEntry): string {
  return entry.lane ?? entry.benchmark;
}

function classLabel(entry: ComparisonEntry): string {
  return entry.laneClass ?? "—";
}

function formatCurrentRef(ref: string): string {
  const prMatch = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
  if (prMatch) {
    return `PR #${prMatch[1]}`;
  }
  return ref;
}

function formatHeader(options: FormatComparisonMarkdownOptions): string[] {
  const lines: string[] = [];
  lines.push(`## ${options.title ?? "Benchmark Comparison"}`);
  if (options.currentCommit || options.currentRef) {
    const parts = [
      options.currentCommit ? `commit \`${options.currentCommit.slice(0, 8)}\`` : "",
      options.currentRef ? `ref \`${formatCurrentRef(options.currentRef)}\`` : "",
    ].filter(Boolean);
    lines.push(`Comparing results for ${parts.join(" on ")}.`);
  }
  return lines;
}

function formatTable(entries: ComparisonEntry[], options: Required<Pick<FormatComparisonMarkdownOptions, "currentLabel" | "baselineLabel">>): string[] {
  const includeLaneClass = entries.some((entry) => entry.laneClass);
  const lines = includeLaneClass
    ? [
      `| Lane | Class | Metric | ${options.baselineLabel} | ${options.currentLabel} | Δ% | Status |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    : [
      `| Lane | Metric | ${options.baselineLabel} | ${options.currentLabel} | Δ% | Status |`,
      "| --- | --- | --- | --- | --- | --- |",
    ];

  for (const entry of sortAlphabetically(entries)) {
    if (includeLaneClass) {
      lines.push(
        `| \`${laneLabel(entry)}\` | \`${classLabel(entry)}\` | \`${entry.metric}\` | ${formatValue(entry.baseline, entry.unit)} | ${formatValue(entry.current, entry.unit)} | ${formatPercent(entry.percentChange)} | ${statusLabel(entry)} |`,
      );
      continue;
    }
    lines.push(
      `| \`${laneLabel(entry)}\` | \`${entry.metric}\` | ${formatValue(entry.baseline, entry.unit)} | ${formatValue(entry.current, entry.unit)} | ${formatPercent(entry.percentChange)} | ${statusLabel(entry)} |`,
    );
  }

  return lines;
}

function groupByMetric(entries: ComparisonEntry[]): Map<string, ComparisonEntry[]> {
  const grouped = new Map<string, ComparisonEntry[]>();
  for (const entry of entries) {
    const key = entry.metric;
    const existing = grouped.get(key);
    if (existing) existing.push(entry);
    else grouped.set(key, [entry]);
  }
  return new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function formatMatrixSummary(result: ComparisonResult): string[] {
  if (!result.matrix) {
    return [];
  }

  const lines = [
    "### Matrix Summary",
    "",
    "| Expected | Observed | Missing | Required Failed | Probe Failed |",
    "| --- | --- | --- | --- | --- |",
    `| ${result.matrix.expectedCount} | ${result.matrix.observedCount} | ${result.matrix.missingResultCount} | ${result.matrix.requiredFailedCount} | ${result.matrix.probeFailedCount} |`,
    "",
    "| Class | Passed | Failed | Missing |",
    "| --- | --- | --- | --- |",
    `| \`required\` | ${result.matrix.requiredPassedCount} | ${result.matrix.requiredFailedCount} | ${result.matrix.lanes.filter((lane) => lane.laneClass === "required" && lane.status === "missing").length} |`,
    `| \`probe\` | ${result.matrix.probePassedCount} | ${result.matrix.probeFailedCount} | ${result.matrix.lanes.filter((lane) => lane.laneClass === "probe" && lane.status === "missing").length} |`,
    "",
  ];

  const interestingLanes = result.matrix.lanes.filter((lane) => lane.status !== "passed");
  if (interestingLanes.length > 0) {
    lines.push("### Matrix Lane Outcomes");
    lines.push("");
    lines.push(...formatLaneOutcomeTable(interestingLanes));
    lines.push("");
  }

  return lines;
}

function sortLanes(lanes: ComparisonMatrixLane[]): ComparisonMatrixLane[] {
  return [...lanes].sort((a, b) => a.label.localeCompare(b.label));
}

function formatLaneOutcomeTable(lanes: ComparisonMatrixLane[]): string[] {
  const lines = [
    "| Lane | Class | Status |",
    "| --- | --- | --- |",
  ];

  for (const lane of sortLanes(lanes)) {
    lines.push(`| \`${lane.label}\` | \`${lane.laneClass}\` | \`${lane.status}\` |`);
  }

  return lines;
}

export function formatComparisonMarkdown(
  result: ComparisonResult,
  options: FormatComparisonMarkdownOptions = {},
): string {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push(...formatHeader(options));
  lines.push("");

  lines.push(...formatMatrixSummary(result));

  const benchmarkEntries = result.entries.filter((entry) => !isMonitorEntry(entry));
  const monitorEntries = result.entries.filter((entry) => isMonitorEntry(entry));
  const regressions = sortAlphabetically(result.entries.filter((entry) => entry.status === "regressed"));

  if (result.entries.length === 0) {
    lines.push("No comparable baseline data found.");
    lines.push("");
  } else if (regressions.length > 0) {
    lines.push("### Regressions");
    lines.push("");
    lines.push(...formatTable(regressions.slice(0, resolved.maxRegressions), resolved));
    if (regressions.length > resolved.maxRegressions) {
      lines.push("");
      lines.push(`Showing ${resolved.maxRegressions} of ${regressions.length} regressions.`);
    }
    lines.push("");
  } else {
    lines.push("No regressions detected.");
    lines.push("");
  }

  if (benchmarkEntries.length > 0) {
    lines.push("### Benchmark Metrics");
    lines.push("");
    lines.push(...formatTable(benchmarkEntries, resolved));
    lines.push("");
  }

  if (monitorEntries.length > 0) {
    lines.push("### Monitor Metrics");
    lines.push("");
    lines.push(...formatTable(monitorEntries, resolved));
    lines.push("");
  }

  if (resolved.includeDetails && result.entries.length > 0) {
    const grouped = groupByMetric(result.entries);
    lines.push("<details>");
    lines.push("<summary>Per-metric detail</summary>");
    lines.push("");
    for (const [metric, entries] of grouped.entries()) {
      lines.push(`#### \`${metric}\``);
      lines.push("");
      lines.push(...formatTable(entries, resolved));
      lines.push("");
    }
    lines.push("</details>");
    lines.push("");
  }

  lines.push(`Generated by [octo11y](${resolved.footerHref}).`);
  return lines.join("\n");
}
