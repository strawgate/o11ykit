import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OtlpMetricsDocument } from "./types.js";

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setAuthHeader(workspace: string, serverUrl: string, token: string): void {
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  runGit(["config", "--local", `http.${serverUrl}/.extraheader`, auth], workspace);
}

function unsetAuthHeader(workspace: string, serverUrl: string): void {
  try {
    runGit(["config", "--local", "--unset", `http.${serverUrl}/.extraheader`], workspace);
  } catch {
    // best effort
  }
}

function pushWithRetry(worktree: string, branch: string, attempts = 3): void {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      runGit(["push", "origin", branch], worktree);
      return;
    } catch (error) {
      lastError = error;
      if (i === attempts) break;
      runGit(
        ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`, "--depth=1"],
        worktree
      );
      runGit(["rebase", `origin/${branch}`], worktree);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Sanitize a runId for safe use as a filename (strip path separators and shell-unsafe chars). */
function sanitizeRunId(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, "_");
}

export function buildRunId(options: {
  readonly customRunId?: string;
  readonly githubRunId?: string;
  readonly githubRunAttempt?: string;
  readonly githubJob?: string;
}): string {
  if (options.customRunId) return sanitizeRunId(options.customRunId);
  const base = `${options.githubRunId ?? "local"}-${options.githubRunAttempt ?? "1"}`;
  if (!options.githubJob) return base;
  const sanitizedJob = options.githubJob
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return sanitizedJob ? `${base}--${sanitizedJob}` : base;
}

export function createTempResultPath(runId: string): string {
  return path.join(os.tmpdir(), `o11ykit-run-${runId}.json`);
}

export function writeResultFile(document: OtlpMetricsDocument, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
}

export function stashResult(options: {
  readonly workspace: string;
  readonly token: string;
  readonly dataBranch: string;
  readonly runId: string;
  readonly document: OtlpMetricsDocument;
}): string {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const worktreePath = path.join(os.tmpdir(), `o11ykit-parse-results-${Date.now()}`);

  setAuthHeader(options.workspace, serverUrl, options.token);
  try {
    let branchExists = false;
    try {
      runGit(
        [
          "fetch",
          "origin",
          `+refs/heads/${options.dataBranch}:refs/remotes/origin/${options.dataBranch}`,
          "--depth=1",
        ],
        options.workspace
      );
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      runGit(["worktree", "add", worktreePath, `origin/${options.dataBranch}`], options.workspace);
      runGit(["checkout", "-B", options.dataBranch], worktreePath);
    } else {
      runGit(["worktree", "add", "--detach", worktreePath], options.workspace);
      runGit(["checkout", "--orphan", options.dataBranch], worktreePath);
      try {
        runGit(["rm", "-rf", "."], worktreePath);
      } catch {
        // orphan branch may already be empty
      }
    }

    const relativePath = `data/runs/${options.runId}.json`;
    const absolutePath = path.join(worktreePath, relativePath);
    writeResultFile(options.document, absolutePath);

    runGit(["add", relativePath], worktreePath);
    try {
      runGit(["diff", "--cached", "--quiet"], worktreePath);
    } catch {
      runGit(
        [
          "-c",
          "user.name=o11ykit[bot]",
          "-c",
          "user.email=o11ykit[bot]@users.noreply.github.com",
          "commit",
          "-m",
          `bench: add run ${options.runId}`,
        ],
        worktreePath
      );
      pushWithRetry(worktreePath, options.dataBranch);
    }
    return relativePath;
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], options.workspace);
    } catch {
      // best effort
    }
    unsetAuthHeader(options.workspace, serverUrl);
  }
}
