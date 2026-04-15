/**
 * OTel Collector stop and push logic.
 *
 * Runs as the action post step. Sends SIGTERM to the collector,
 * waits for it to flush, then pushes the raw OTLP JSONL file
 * to the data branch.
 */

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
  checkoutDataBranch,
  configureGit,
  pushWithRetry,
} from "@benchkit/actions-common";
import { DEFAULT_PUSH_RETRY_COUNT, type OtlpMetricsDocument } from "@octo11y/core";
import type { OtelState } from "./types.js";

export function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

const CI_NOISE_PATTERNS: RegExp[] = [
  /unknown userid/i,
  /process.*no such process/i,
  /process.*does not exist/i,
  /failed to read process/i,
  /error scraping.*process/i,
];

export function suppressExpectedCiNoise(log: string): {
  filteredLog: string;
  suppressedLineCount: number;
} {
  let suppressedLineCount = 0;
  const kept: string[] = [];
  for (const line of log.split("\n")) {
    if (CI_NOISE_PATTERNS.some((pattern) => pattern.test(line))) {
      suppressedLineCount += 1;
      continue;
    }
    kept.push(line);
  }
  return {
    filteredLog: kept.join("\n").trim(),
    suppressedLineCount,
  };
}

export async function stopCollector(state: OtelState): Promise<void> {
  if (!isProcessRunning(state.pid)) {
    core.info("Collector process already exited.");
    return;
  }

  // On Windows, SIGTERM/SIGKILL don't work; use process.kill(pid) without signal
  const isWindows = process.platform === "win32";
  const signal = isWindows ? undefined : ("SIGTERM" as const);
  const signalName = isWindows ? "terminate" : "SIGTERM";

  core.info(`Sending ${signalName} to collector (PID ${state.pid})...`);
  try {
    process.kill(state.pid, signal);
  } catch {
    core.info("Collector already gone.");
    return;
  }

  // Wait up to 10s for graceful shutdown (flushes pending data)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(state.pid)) {
      core.info("Collector exited cleanly.");
      return;
    }
    await sleep(200);
  }

  // Force kill if still running
  core.warning("Collector did not exit in time, sending force kill.");
  try {
    process.kill(state.pid, isWindows ? undefined : ("SIGKILL" as const));
  } catch {
    // already gone
  }
}

/**
 * Extract an integer attribute from an OTLP resource's attributes array.
 */
function getIntAttribute(
  attributes: Array<{ key: string; value: Record<string, unknown> }>,
  key: string,
): number | undefined {
  const attr = attributes.find((a) => a.key === key);
  if (!attr) return undefined;
  const raw = attr.value.intValue ?? attr.value.stringValue;
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Build a pid→parent_pid map from all process resources in OTLP JSONL,
 * then return the set of PIDs that are descendants of `ancestorPid`.
 */
export function findDescendantPids(
  content: string,
  ancestorPid: number,
): Set<number> {
  const parentOf = new Map<number, number>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { resourceMetrics?: Array<{ resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> } }> };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const rm of parsed.resourceMetrics ?? []) {
      const attrs = rm.resource?.attributes ?? [];
      const pid = getIntAttribute(attrs, "process.pid");
      const ppid = getIntAttribute(attrs, "process.parent_pid");
      if (pid !== undefined && ppid !== undefined) {
        parentOf.set(pid, ppid);
      }
    }
  }

  // Walk up from each PID; if the chain reaches ancestorPid, it's a descendant.
  // Cache results to avoid repeated walks.
  const cache = new Map<number, boolean>();
  cache.set(ancestorPid, true);

  function isDescendant(pid: number): boolean {
    if (cache.has(pid)) return cache.get(pid)!;
    const parent = parentOf.get(pid);
    if (parent === undefined) {
      cache.set(pid, false);
      return false;
    }
    // Guard against cycles
    cache.set(pid, false);
    const result = isDescendant(parent);
    cache.set(pid, result);
    return result;
  }

  const descendants = new Set<number>();
  for (const pid of parentOf.keys()) {
    if (isDescendant(pid)) descendants.add(pid);
  }
  return descendants;
}

/**
 * Filter OTLP JSONL to keep only process resources that are descendants
 * of the runner worker PID. System-level metrics (no process.pid) and
 * user-sent OTLP metrics pass through unmodified.
 */
export function filterToRunnerDescendants(
  content: string,
  runnerPpid: number,
): { filtered: string; kept: number; removed: number } {
  const descendants = findDescendantPids(content, runnerPpid);

  let kept = 0;
  let removed = 0;
  const outputLines: string[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    let parsed: { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> }; scopeMetrics: unknown[] }> };
    try {
      parsed = JSON.parse(line);
    } catch {
      outputLines.push(line);
      continue;
    }

    if (!parsed.resourceMetrics) {
      outputLines.push(line);
      continue;
    }

    const filteredResources = parsed.resourceMetrics.filter((rm) => {
      const pid = getIntAttribute(rm.resource?.attributes ?? [], "process.pid");
      const ppid = getIntAttribute(rm.resource?.attributes ?? [], "process.parent_pid");
      // Only filter hostmetrics process resources (those with process.parent_pid).
      // Keep: no PID (system metrics), no parent_pid (user OTLP metrics), or descendant process
      if (ppid === undefined || pid === undefined || descendants.has(pid)) {
        kept++;
        return true;
      }
      removed++;
      return false;
    });

    if (filteredResources.length > 0) {
      outputLines.push(JSON.stringify({ ...parsed, resourceMetrics: filteredResources }));
    }
  }

  return { filtered: outputLines.join("\n") + "\n", kept, removed };
}

export function consolidateJsonl(content: string): OtlpMetricsDocument {
  const resourceMetrics: NonNullable<OtlpMetricsDocument["resourceMetrics"]> = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { resourceMetrics?: OtlpMetricsDocument["resourceMetrics"] };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(parsed.resourceMetrics)) {
      resourceMetrics.push(...parsed.resourceMetrics);
    }
  }
  return { resourceMetrics };
}

export function writeMonitorMetricsDoc(metricsDir: string, content: string): string {
  const monitorDocPath = path.join(metricsDir, "monitor.otlp.json");
  fs.mkdirSync(metricsDir, { recursive: true });
  const doc = consolidateJsonl(content);
  fs.writeFileSync(monitorDocPath, `${JSON.stringify(doc, null, 2)}\n`);
  return monitorDocPath;
}

async function pushTelemetryToDataBranch(state: OtelState): Promise<void> {
  if (!fs.existsSync(state.outputPath)) {
    core.warning("No telemetry output file found — nothing to push.");
    return;
  }

  const stats = fs.statSync(state.outputPath);
  if (stats.size === 0) {
    core.warning("Telemetry output file is empty — nothing to push.");
    return;
  }

  core.info(
    `Telemetry file: ${state.outputPath} (${(stats.size / 1024).toFixed(1)} KB)`,
  );

  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning("No github-token provided — skipping data branch push.");
    return;
  }
  core.setSecret(token);

  await configureGit(token);
  const worktreePath = await checkoutDataBranch(state.dataBranch, "benchkit-monitor");

  try {
    // Write telemetry file (gzipped)
    const telemetryDir = path.join(worktreePath, "data", "runs", state.runId);
    fs.mkdirSync(telemetryDir, { recursive: true });
    const targetPath = path.join(telemetryDir, "telemetry.otlp.jsonl.gz");
    if (fs.existsSync(targetPath)) {
      throw new Error(
        `Refusing to overwrite existing telemetry sidecar: data/runs/${state.runId}/telemetry.otlp.jsonl.gz `
        + `already exists on '${state.dataBranch}'. run-id values must be unique per write.`,
      );
    }
    const raw = fs.readFileSync(state.outputPath);
    const compressed = gzipSync(raw);
    fs.writeFileSync(targetPath, compressed);

    await exec.exec("git", ["-C", worktreePath, "add", targetPath]);
    await exec.exec("git", ["-C", worktreePath, "commit", "-m", `telemetry: store run ${state.runId}`]);
    await pushWithRetry(worktreePath, state.dataBranch, DEFAULT_PUSH_RETRY_COUNT);
    core.info(`Telemetry pushed to ${state.dataBranch} for run ${state.runId}`);
  } finally {
    await exec.exec("git", ["worktree", "remove", worktreePath, "--force"], {
      ignoreReturnCode: true,
    });
  }
}

export async function stopOtelCollector(): Promise<void> {
  const statePath = core.getState("otel-state-path");
  if (!statePath || !fs.existsSync(statePath)) {
    core.info("No OTel Collector state found — was the monitor started?");
    return;
  }

  let state: OtelState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (err) {
    core.warning(`Failed to read collector state: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!state.pid || !state.outputPath) {
    core.warning("Collector state is incomplete — skipping.");
    return;
  }

  await stopCollector(state);

  const profile = state.profile ?? "default";
  let suppressedCollectorLogLines = 0;
  const metricsDir = state.metricsDir || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "benchkit-metrics");

  // Dump collector logs for diagnostics
  if (state.logPath && fs.existsSync(state.logPath)) {
    const log = fs.readFileSync(state.logPath, "utf-8");
    let renderedLog = log.trim();
    if (profile === "ci" && renderedLog) {
      const suppression = suppressExpectedCiNoise(renderedLog);
      renderedLog = suppression.filteredLog;
      suppressedCollectorLogLines = suppression.suppressedLineCount;
      if (suppressedCollectorLogLines > 0) {
        core.info(
          `CI profile suppressed ${suppressedCollectorLogLines} expected collector log line(s).`,
        );
      }
    }
    if (renderedLog) {
      core.startGroup("OTel Collector logs");
      core.info(renderedLog);
      core.endGroup();
    }
  }

  if (fs.existsSync(state.outputPath)) {
    let telemetryContent = fs.readFileSync(state.outputPath, "utf-8");
    if (state.runnerPpid) {
      const { filtered, kept, removed } = filterToRunnerDescendants(telemetryContent, state.runnerPpid);
      telemetryContent = filtered;
      fs.writeFileSync(state.outputPath, telemetryContent);
      core.info(
        `Filtered processes: ${kept} resources kept, ${removed} non-runner resources removed`,
      );
    }
    const monitorDocPath = writeMonitorMetricsDoc(metricsDir, telemetryContent);
    core.info(`Wrote consolidated monitor metrics: ${monitorDocPath}`);
  }

  try {
    await pushTelemetryToDataBranch(state);
  } catch (err) {
    core.warning(`Failed to push telemetry: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Write job summary
  const summary = core.summary.addHeading("OTel Monitor Summary");
  if (fs.existsSync(state.outputPath)) {
    const raw = fs.readFileSync(state.outputPath);
    const compressed = gzipSync(raw);
    summary.addRaw(`✅ Telemetry collected and pushed\n`);
    summary.addRaw(`Original: ${(raw.length / 1024).toFixed(1)} KB\n`);
    summary.addRaw(`Compressed: ${(compressed.length / 1024).toFixed(1)} KB\n`);
    if (profile === "ci") {
      summary.addRaw(`Suppressed collector log lines (CI profile): ${suppressedCollectorLogLines}\n`);
    }
  }
  await summary.write();

  // Clean up temp files
  safeUnlink(statePath);
  safeUnlink(state.configPath);
  if (state.logPath) safeUnlink(state.logPath);
  // Keep the OTLP output file in case other steps want to read it
}
