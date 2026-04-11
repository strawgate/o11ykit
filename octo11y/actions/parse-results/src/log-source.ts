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

interface RunJobSummary {
  id: number;
  name: string;
  status?: string;
}

function parseRunJobs(payload: unknown): RunJobSummary[] {
  if (!payload || typeof payload !== "object" || !("jobs" in payload)) {
    return [];
  }
  const jobs = (payload as { jobs?: Array<{ id?: number; name?: string; status?: string }> }).jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((j) => ({ id: j.id ?? 0, name: j.name ?? "", status: j.status }))
    .filter((j) => j.id > 0 && j.name.length > 0);
}

async function fetchRunJobs(token: string): Promise<RunJobSummary[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!repo || !runId) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required for job log lookup");
  }

  const jobsAttemptUrl = runAttempt
    ? `${apiBase}/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`
    : "";
  const jobsRunUrl = `${apiBase}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;

  try {
    const payload = jobsAttemptUrl
      ? await requestJson(jobsAttemptUrl, token)
      : await requestJson(jobsRunUrl, token);
    return parseRunJobs(payload);
  } catch (err) {
    if (!jobsAttemptUrl) throw err;
    const payload = await requestJson(jobsRunUrl, token);
    return parseRunJobs(payload);
  }
}

async function downloadJobLogsWithRetry(
  token: string,
  jobLogsUrl: string,
  attempts: number,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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

async function loadAvailableJobLogs(token: string): Promise<string> {
  const repo = process.env.GITHUB_REPOSITORY;
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const currentJob = process.env.GITHUB_JOB || "";
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required for job log lookup");
  }

  const jobs = await fetchRunJobs(token);
  if (jobs.length === 0) {
    throw new Error("Could not resolve any jobs for this run");
  }

  const preferred = [
    ...jobs.filter((j) => j.name !== currentJob && j.status === "completed"),
    ...jobs.filter((j) => j.name === currentJob),
    ...jobs.filter((j) => j.name !== currentJob && j.status !== "completed"),
  ];

  const seen = new Set<number>();
  const chunks: string[] = [];
  let lastError: unknown;

  for (const job of preferred) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const logsUrl = `${apiBase}/repos/${repo}/actions/jobs/${job.id}/logs`;
    const retries = job.name === currentJob ? 8 : 1;
    try {
      const text = await downloadJobLogsWithRetry(token, logsUrl, retries);
      chunks.push(text);
    } catch (err) {
      lastError = err;
    }
  }

  if (chunks.length > 0) {
    return chunks.join("\n");
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to download job logs");
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

  // Prefer per-job logs: completed sibling jobs are available during the run,
  // and current-job logs may become available shortly after start.
  try {
    return await loadAvailableJobLogs(token);
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
