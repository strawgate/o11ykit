import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tc from "@actions/tool-cache";

const GITHUB_API_VERSION = "2022-11-28";

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out.sort();
}

function isTextLogFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith(".txt") || name.endsWith(".log");
}

async function downloadLogsArchive(url: string, token: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Logs API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const bytes = await res.arrayBuffer();
  return Buffer.from(bytes);
}

async function requestJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Logs API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return res.json();
}

async function downloadJobLogs(url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Logs API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findCurrentJobId(payload: unknown, githubJob: string): number | undefined {
  if (!payload || typeof payload !== "object" || !("jobs" in payload)) {
    return undefined;
  }
  const jobs = (payload as { jobs?: Array<{ id?: number; name?: string }> }).jobs;
  if (!Array.isArray(jobs)) return undefined;
  return jobs.find((j) => j?.name === githubJob)?.id;
}

async function loadCurrentJobLogs(token: string): Promise<string> {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const githubJob = process.env.GITHUB_JOB;
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!repo || !runId || !githubJob) {
    throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_JOB are required for job log lookup");
  }

  const jobsAttemptUrl = runAttempt
    ? `${apiBase}/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`
    : "";
  const jobsRunUrl = `${apiBase}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;

  let jobsPayload: unknown;
  try {
    jobsPayload = jobsAttemptUrl
      ? await requestJson(jobsAttemptUrl, token)
      : await requestJson(jobsRunUrl, token);
  } catch (err) {
    if (!jobsAttemptUrl) throw err;
    jobsPayload = await requestJson(jobsRunUrl, token);
  }

  const jobId = findCurrentJobId(jobsPayload, githubJob);
  if (!jobId) {
    throw new Error(`Could not resolve current job id for GITHUB_JOB=${githubJob}`);
  }

  const jobLogsUrl = `${apiBase}/repos/${repo}/actions/jobs/${jobId}/logs`;

  // Job logs can return 404 briefly while the runner initializes uploads.
  // Retry with short backoff to make auto mode reliable within the same run.
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await downloadJobLogs(jobLogsUrl, token);
    } catch (err) {
      lastError = err;
      await sleep(1500);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to download current job logs");
}

export async function loadWorkflowAttemptLogs(token: string): Promise<string> {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required for mode=auto");
  }
  if (!runId) {
    throw new Error("GITHUB_RUN_ID is required for mode=auto");
  }

  // Prefer current job logs: this is available during the run and avoids
  // relying on workflow-level log archives, which can be unavailable (404)
  // until the entire run has completed.
  try {
    return await loadCurrentJobLogs(token);
  } catch {
    // Fall back to workflow archive retrieval below.
  }

  const attemptUrl = runAttempt
    ? `${apiBase}/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/logs`
    : "";
  const runUrl = `${apiBase}/repos/${repo}/actions/runs/${runId}/logs`;

  let archive: Buffer;
  try {
    archive = attemptUrl
      ? await downloadLogsArchive(attemptUrl, token)
      : await downloadLogsArchive(runUrl, token);
  } catch (err) {
    if (!attemptUrl) throw err;
    archive = await downloadLogsArchive(runUrl, token);
  }

  const zipPath = path.join(
    os.tmpdir(),
    `benchkit-run-logs-${runId}-${runAttempt ?? "1"}-${Date.now()}.zip`,
  );
  fs.writeFileSync(zipPath, archive);

  const extracted = await tc.extractZip(zipPath);
  const files = walkFiles(extracted).filter(isTextLogFile);
  if (files.length === 0) {
    throw new Error("Downloaded logs archive did not contain any .txt/.log files.");
  }

  const chunks = files.map((filePath) => fs.readFileSync(filePath, "utf-8"));
  return chunks.join("\n");
}
