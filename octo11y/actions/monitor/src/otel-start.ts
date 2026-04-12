/**
 * OTel Collector start logic.
 *
 * Downloads otelcol-contrib, generates config, spawns the collector
 * as a detached background process, and writes state for the post step.
 */

import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as fs from "node:fs";
import { DEFAULT_DATA_BRANCH } from "@benchkit/format";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  generateCollectorConfig,
  validateMetricSets,
} from "./otel-config.js";
import type { MonitorProfile, OtelState } from "./types.js";

const STATE_NAME = ".benchkit-otel.state.json";
const DEFAULT_METRIC_SETS = ["cpu", "memory", "load", "process"];
const CI_PROFILE_DEFAULT_METRIC_SETS = ["cpu", "memory", "load", "process"];

function runnerTemp(): string {
  return process.env.RUNNER_TEMP || os.tmpdir();
}

export function platformArch(): { os: string; arch: string; ext: string } {
  const platform = process.platform;
  const arch = process.arch;

  let os: string;
  if (platform === "linux") os = "linux";
  else if (platform === "darwin") os = "darwin";
  else if (platform === "win32") os = "windows";
  else throw new Error(`Unsupported platform: ${platform}`);

  let otelArch: string;
  if (arch === "x64") otelArch = "amd64";
  else if (arch === "arm64") otelArch = "arm64";
  else throw new Error(`Unsupported architecture: ${arch}`);

  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { os, arch: otelArch, ext };
}

export function downloadUrl(version: string, os: string, arch: string, ext: string): string {
  return (
    `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/` +
    `v${version}/otelcol-contrib_${version}_${os}_${arch}.${ext}`
  );
}

/**
 * Parse and validate a port number input.
 * Throws a descriptive error if the value is not a valid integer in the range 1–65535.
 */
export function validatePort(inputName: string, raw: string): number {
  const port = parseInt(raw, 10);
  if (isNaN(port)) {
    throw new Error(`Invalid port number for ${inputName}: expected a number, got '${raw}'`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port number for ${inputName}: ${port} is out of range (1–65535)`);
  }
  return port;
}

async function ensureCollectorBinary(version: string): Promise<string> {
  const { os, arch, ext } = platformArch();
  const toolName = "otelcol-contrib";

  // Check cache first
  let toolDir = tc.find(toolName, version, arch);
  if (!toolDir) {
    const url = downloadUrl(version, os, arch, ext);
    core.info(`Downloading OTel Collector v${version} from ${url}`);
    const archive = await tc.downloadTool(url);
    const extracted =
      ext === "zip"
        ? await tc.extractZip(archive)
        : await tc.extractTar(archive);
    toolDir = await tc.cacheDir(extracted, toolName, version, arch);
  } else {
    core.info(`OTel Collector v${version} found in tool cache`);
  }

  const binaryName = process.platform === "win32" ? "otelcol-contrib.exe" : "otelcol-contrib";
  const binaryPath = path.join(toolDir, binaryName);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Collector binary not found at ${binaryPath}`);
  }
  return binaryPath;
}

/** Sanitize a runId for safe use as a filename (strip path separators). */
function sanitizeRunId(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, "_");
}

export function resolveProfile(raw: string): MonitorProfile {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "default") return "default";
  if (normalized === "ci") return "ci";
  throw new Error(`Invalid profile '${raw}'. Expected 'default' or 'ci'.`);
}

export function resolveMetricSetsInput(raw: string, profile: MonitorProfile): string[] {
  if (raw.trim() !== "") {
    return raw.split(",");
  }
  return profile === "ci"
    ? [...CI_PROFILE_DEFAULT_METRIC_SETS]
    : [...DEFAULT_METRIC_SETS];
}

export function resolveRunId(): string {
  const explicit = core.getInput("run-id");
  if (explicit) return sanitizeRunId(explicit);
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  if (runId) return sanitizeRunId(`${runId}-${attempt}`);
  return `local-${Date.now()}`;
}

export async function waitForOtlpHttpReady(
  port: number,
  timeoutMs: number,
  pollIntervalMs = 200,
): Promise<boolean> {
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      core.info(`OTel Collector is ready on port ${port}`);
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }
  }
  core.warning(
    `OTel Collector did not become ready within ${timeoutMs}ms (last error: ${lastError}). Continuing anyway.`,
  );
  return false;
}

export async function startOtelCollector(): Promise<void> {
  const version = core.getInput("collector-version") || "0.149.0";
  const scrapeInterval = core.getInput("scrape-interval") || "5s";
  const profile = resolveProfile(core.getInput("profile") || "default");
  const metricSetsInput = core.getInput("metric-sets");
  const metricSetsRaw = resolveMetricSetsInput(metricSetsInput, profile);
  const otlpGrpcPort = validatePort("otlp-grpc-port", core.getInput("otlp-grpc-port") || "4317");
  const otlpHttpPort = validatePort("otlp-http-port", core.getInput("otlp-http-port") || "4318");
  const dataBranch = core.getInput("data-branch") || DEFAULT_DATA_BRANCH;
  const runId = resolveRunId();

  const metricSets = validateMetricSets(metricSetsRaw);

  // Record the runner worker PID (our parent) so the post step can
  // filter process metrics to only runner descendants. This works
  // cross-platform — no /proc required.
  const runnerPpid = metricSets.includes("process")
    ? process.ppid
    : undefined;

  const outputPath = path.join(runnerTemp(), "benchkit-telemetry.otlp.jsonl");
  const configPath = path.join(runnerTemp(), "otelcol-config.yaml");
  const logPath = path.join(runnerTemp(), "otelcol.log");

  // Generate collector config
  const configYaml = generateCollectorConfig({
    scrapeInterval,
    metricSets,
    otlpGrpcPort,
    otlpHttpPort,
    outputPath,
    runId,
    ref: process.env.GITHUB_REF,
    commit: process.env.GITHUB_SHA,
    muteProcessAllErrors: profile === "ci",
  });
  fs.writeFileSync(configPath, configYaml);
  core.info(`Collector config written to ${configPath}`);

  // Download collector binary
  const binary = await ensureCollectorBinary(version);

  // Spawn collector as detached background process with log capture
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(binary, ["--config", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to spawn OTel Collector process");
  }

  // Wait for the OTLP HTTP port to be ready before returning.
  // The collector takes ~500ms-1s to bind on a cold start, so emit-metric
  // calls in the immediately following step would otherwise hit ECONNREFUSED.
  if (otlpHttpPort > 0) {
    const ready = await waitForOtlpHttpReady(otlpHttpPort, 15_000);
    if (!ready) {
      throw new Error(
        `OTel Collector did not become ready on port ${otlpHttpPort}; refusing to publish an unreachable OTLP HTTP endpoint.`,
      );
    }
  }

  // Write state for the post step
  const state: OtelState = {
    pid: child.pid,
    configPath,
    outputPath,
    logPath,
    startTime: Date.now(),
    runId,
    dataBranch,
    profile,
    runnerPpid,
  };
  const statePath = path.join(runnerTemp(), STATE_NAME);
  fs.writeFileSync(statePath, JSON.stringify(state));

  // Save state path for the post step via action state
  core.saveState("otel-state-path", statePath);

  // Set outputs
  if (otlpGrpcPort > 0) {
    core.setOutput("otlp-grpc-endpoint", `grpc://localhost:${otlpGrpcPort}`);
  }
  if (otlpHttpPort > 0) {
    core.setOutput("otlp-http-endpoint", `http://localhost:${otlpHttpPort}`);
  }

  core.info(
    `OTel Collector started (PID ${child.pid}, scrape interval ${scrapeInterval}, profile ${profile})`,
  );
  core.info(`Enabled metric sets: ${metricSets.join(", ") || "(none)"}`);
  if (otlpGrpcPort > 0) core.info(`OTLP gRPC endpoint: grpc://localhost:${otlpGrpcPort}`);
  if (otlpHttpPort > 0) core.info(`OTLP HTTP endpoint: http://localhost:${otlpHttpPort}`);
}
