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

function isLogTextFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith(".txt") || name.endsWith(".log");
}

async function downloadLogsArchive(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Logs API request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

interface RunJob {
  readonly id: number;
  readonly name: string;
  readonly started_at?: string;
}

async function listRunJobs(options: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly runId: string;
  readonly token: string;
  readonly runAttempt?: string;
}): Promise<readonly RunJob[]> {
  const endpoint = new URL(
    `${options.apiUrl}/repos/${options.repository}/actions/runs/${options.runId}/jobs`
  );
  endpoint.searchParams.set("per_page", "100");
  if (options.runAttempt) endpoint.searchParams.set("attempt_number", options.runAttempt);

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jobs API request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const parsed = (await response.json()) as { jobs?: RunJob[] };
  return parsed.jobs ?? [];
}

async function downloadCurrentJobLogs(options: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt?: string;
  readonly jobName: string;
  readonly token: string;
}): Promise<Buffer> {
  const jobs = await listRunJobs(options);
  const matching = jobs
    .filter((job) => job.name === options.jobName)
    .sort((a, b) => (Date.parse(b.started_at ?? "") || 0) - (Date.parse(a.started_at ?? "") || 0));
  if (matching.length === 0) {
    throw new Error(`Could not find a job named "${options.jobName}" in run ${options.runId}.`);
  }

  let lastError: unknown;
  for (const job of matching) {
    const jobLogsUrl = `${options.apiUrl}/repos/${options.repository}/actions/jobs/${job.id}/logs`;
    try {
      return await downloadLogsArchive(jobLogsUrl, options.token);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function readCurrentRunLogs(
  token: string,
  options?: {
    readonly runId?: string;
    readonly runAttempt?: string;
    readonly jobName?: string;
  }
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = options?.runId ?? process.env.GITHUB_RUN_ID;
  const runAttempt = options?.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT;
  const jobName = options?.jobName ?? process.env.GITHUB_JOB;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required for mode=auto");
  }
  if (!runId) {
    throw new Error("GITHUB_RUN_ID is required for mode=auto");
  }

  const attemptUrl = runAttempt
    ? `${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/logs`
    : undefined;
  const runUrl = `${apiUrl}/repos/${repository}/actions/runs/${runId}/logs`;

  let archive: Buffer | undefined;
  const runLogErrors: string[] = [];
  for (const url of [attemptUrl, runUrl]) {
    if (!url) continue;
    try {
      archive = await downloadLogsArchive(url, token);
      break;
    } catch (error) {
      runLogErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!archive) {
    if (!jobName) {
      throw new Error(runLogErrors.join(" | "));
    }
    try {
      archive = await downloadCurrentJobLogs({
        apiUrl,
        repository,
        runId,
        jobName,
        token,
        ...(runAttempt ? { runAttempt } : {}),
      });
    } catch (jobError) {
      const combined = [
        ...runLogErrors,
        jobError instanceof Error ? jobError.message : String(jobError),
      ];
      throw new Error(combined.join(" | "));
    }
  }

  const zipPath = path.join(
    os.tmpdir(),
    `o11ykit-run-logs-${runId}-${runAttempt ?? "1"}-${Date.now()}.zip`
  );
  fs.writeFileSync(zipPath, archive);

  const extractedDir = await tc.extractZip(zipPath);
  const files = walkFiles(extractedDir).filter(isLogTextFile);
  if (files.length === 0) {
    throw new Error("Downloaded logs archive did not contain any .txt/.log files.");
  }

  return files.map((filePath) => fs.readFileSync(filePath, "utf-8")).join("\n");
}
