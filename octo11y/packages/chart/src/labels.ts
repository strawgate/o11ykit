const MONITOR_METRIC_LABELS: Record<string, string> = {
  cpu_system_ms: "CPU system time (ms)",
  cpu_system_pct: "CPU system %",
  cpu_user_ms: "CPU user time (ms)",
  cpu_user_pct: "CPU user %",
  final_rss_kb: "Final RSS (KB)",
  involuntary_ctx_switches: "Involuntary context switches",
  io_read_bytes: "I/O read bytes",
  io_write_bytes: "I/O write bytes",
  load_avg_1m_max: "Peak load average (1m)",
  mem_available_min_mb: "Lowest available memory (MB)",
  peak_rss_kb: "Peak RSS (KB)",
  voluntary_ctx_switches: "Voluntary context switches",
  wall_clock_ms: "Wall clock time (ms)",
};

function titleCase(input: string): string {
  return input.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function defaultMetricLabel(metric: string): string {
  if (metric.startsWith("_monitor/")) {
    return defaultMonitorMetricLabel(metric);
  }

  return metric
    .replace(/_per_/g, "/")
    .replace(/_/g, " ");
}

/** Returns true when the metric name belongs to the monitor action's output. */
export function isMonitorMetric(metric: string): boolean {
  return metric.startsWith("_monitor/");
}

export function defaultMonitorMetricLabel(metric: string): string {
  const raw = metric.replace(/^_monitor\//, "");
  if (MONITOR_METRIC_LABELS[raw]) {
    return MONITOR_METRIC_LABELS[raw];
  }

  if (raw.startsWith("process/")) {
    return `Process ${titleCase(raw.replace(/^process\//, "").replace(/_/g, " "))}`;
  }

  return titleCase(raw.replace(/\//g, " ").replace(/_/g, " "));
}
