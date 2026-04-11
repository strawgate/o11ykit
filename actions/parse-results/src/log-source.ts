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

export async function readCurrentRunLogs(token: string): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required for mode=auto");
  }
  if (!runId) {
    throw new Error("GITHUB_RUN_ID is required for mode=auto");
  }

  const attemptUrl = runAttempt
    ? `${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/logs`
    : "";
  const runUrl = `${apiUrl}/repos/${repository}/actions/runs/${runId}/logs`;

  let archive: Buffer;
  try {
    archive = attemptUrl
      ? await downloadLogsArchive(attemptUrl, token)
      : await downloadLogsArchive(runUrl, token);
  } catch (error) {
    if (!attemptUrl) throw error;
    archive = await downloadLogsArchive(runUrl, token);
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
