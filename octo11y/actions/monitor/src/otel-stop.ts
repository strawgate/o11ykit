/**
 * OTel Collector stop and push logic.
 *
 * Runs as the action post step. Sends SIGTERM to the collector,
 * waits for it to flush, then pushes the raw OTLP JSONL file
 * to the data branch.
 */

import * as core from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
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

function git(args: string[], cwd?: string, timeout = 30_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
  }).trim();
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

function pushTelemetryToDataBranch(state: OtelState): void {
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

  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    core.warning("GITHUB_WORKSPACE not set — skipping data branch push.");
    return;
  }

  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";

  // Use a temporary worktree to commit to the data branch without
  // disturbing the main checkout.
  const worktreePath = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    "benchkit-data-worktree",
  );

  // Clean up any leftover worktree from a previous run
  if (fs.existsSync(worktreePath)) {
    try {
      git(["worktree", "remove", "--force", worktreePath], workspace);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  try {
    // Configure git auth
    git(
      ["config", "--local", `http.${serverUrl}/.extraheader`,
       `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`],
      workspace,
    );

    // Fetch the data branch (or create it as an orphan)
    let branchExists = false;
    try {
      git(["fetch", "origin", state.dataBranch, "--depth=1"], workspace);
      branchExists = true;
    } catch {
      // branch does not exist yet
    }

    if (branchExists) {
      git(
        ["worktree", "add", worktreePath, `origin/${state.dataBranch}`],
        workspace,
      );
      // Detach from remote tracking and create local branch
      git(["checkout", "-B", state.dataBranch], worktreePath);
    } else {
      git(["worktree", "add", "--detach", worktreePath], workspace);
      git(["checkout", "--orphan", state.dataBranch], worktreePath);
      git(["rm", "-rf", "."], worktreePath);
    }

    // Write telemetry file (gzipped)
    const telemetryDir = path.join(worktreePath, "data", "telemetry");
    fs.mkdirSync(telemetryDir, { recursive: true });
    const targetPath = path.join(telemetryDir, `${state.runId}.otlp.jsonl.gz`);
    const raw = fs.readFileSync(state.outputPath);
    const compressed = gzipSync(raw);
    fs.writeFileSync(targetPath, compressed);

    // Commit and push
    git(["add", targetPath], worktreePath);

    // Check if there are changes to commit
    try {
      git(["diff", "--cached", "--quiet"], worktreePath);
      core.info("No changes to commit.");
      return;
    } catch {
      // diff --quiet exits non-zero if there are staged changes — good
    }

    git(
      [
        "-c", "user.name=benchkit[bot]",
        "-c", "user.email=benchkit[bot]@users.noreply.github.com",
        "commit", "-m", `telemetry: store run ${state.runId}`,
      ],
      worktreePath,
    );

    // Retry push up to 3 times with rebase to handle concurrent pushes
    let pushed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        git(["push", "origin", state.dataBranch], worktreePath, 120_000);
        core.info(`Telemetry pushed to ${state.dataBranch} for run ${state.runId}`);
        pushed = true;
        break;
      } catch (err) {
        if (attempt === 3) {
          throw err; // Fail after 3 attempts
        }
        core.info(`Push attempt ${attempt} failed, rebasing and retrying...`);
        try {
          // Fetch latest and rebase
          git(["fetch", "origin", state.dataBranch, "--depth=1"], workspace);
          git(["rebase", `origin/${state.dataBranch}`], worktreePath);
          // Re-stage and re-commit after rebase
          git(["add", targetPath], worktreePath);
          git(
            [
              "-c", "user.name=benchkit[bot]",
              "-c", "user.email=benchkit[bot]@users.noreply.github.com",
              "commit", "--allow-empty", "-m", `telemetry: store run ${state.runId}`,
            ],
            worktreePath,
          );
        } catch (rebaseErr) {
          core.warning(`Rebase failed: ${rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr)}`);
          throw err; // Throw original push error if rebase fails
        }
      }
    }
    if (!pushed) {
      throw new Error("Failed to push telemetry after retries");
    }
  } finally {
    // Clean up git auth header
    try {
      git(["config", "--local", "--unset", `http.${serverUrl}/.extraheader`], workspace);
    } catch {
      // best effort
    }
    // Clean up worktree
    try {
      git(["worktree", "remove", "--force", worktreePath], workspace);
    } catch {
      // best effort
    }
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

  // Dump collector logs for diagnostics
  if (state.logPath && fs.existsSync(state.logPath)) {
    const log = fs.readFileSync(state.logPath, "utf-8").trim();
    if (log) {
      core.startGroup("OTel Collector logs");
      core.info(log);
      core.endGroup();
    }
  }

  // Filter process metrics to only runner descendants
  if (state.runnerPpid && fs.existsSync(state.outputPath)) {
    const raw = fs.readFileSync(state.outputPath, "utf-8");
    const { filtered, kept, removed } = filterToRunnerDescendants(raw, state.runnerPpid);
    fs.writeFileSync(state.outputPath, filtered);
    core.info(
      `Filtered processes: ${kept} resources kept, ${removed} non-runner resources removed`,
    );
  }

  try {
    pushTelemetryToDataBranch(state);
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
  }
  await summary.write();

  // Clean up temp files
  safeUnlink(statePath);
  safeUnlink(state.configPath);
  if (state.logPath) safeUnlink(state.logPath);
  // Keep the OTLP output file in case other steps want to read it
}
