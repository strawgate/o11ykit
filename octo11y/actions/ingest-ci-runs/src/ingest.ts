import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkoutDataBranch,
  configureGit,
  pushWithRetry,
} from "@benchkit/actions-common";
import { DEFAULT_PUSH_RETRY_COUNT } from "@octo11y/core";

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_CURSOR_PATH = "data/state/benchkit-ci-run-ingest.cursor.json";
const LEGACY_CURSOR_PATH = "data/state/ingest-cursor.json";

export interface WorkflowRun {
  readonly id: number;
  readonly run_attempt: number;
  readonly name?: string;
  readonly path?: string;
  readonly workflow_id?: number;
  readonly event?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly html_url?: string;
}

export interface CursorFile {
  readonly latestWorkflowRunCreatedAt?: string;
  // Legacy field retained for backward compatibility with earlier cursor files.
  readonly latestCreatedAt?: string;
  readonly updatedAt?: string;
  readonly sourceAction?: string;
  readonly source?: string;
}

export interface CandidateRun {
  readonly id: string;
  readonly run_attempt: string;
  readonly workflow_name: string;
  readonly event: string;
  readonly created_at: string;
  readonly html_url: string;
}

interface ListRunsResponse {
  readonly workflow_runs?: WorkflowRun[];
}

function parseCsvSet(input: string): Set<string> {
  return new Set(
    input
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isValidIso(iso: string): boolean {
  return Number.isFinite(Date.parse(iso));
}

function normalizeCursorPath(cursorPath: string): string {
  if (!cursorPath.trim()) {
    throw new Error("cursor-path must not be empty.");
  }
  if (path.isAbsolute(cursorPath)) {
    throw new Error("cursor-path must be relative to the data branch root.");
  }
  const normalized = path.normalize(cursorPath).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`cursor-path must stay within the repository root: ${cursorPath}`);
  }
  return normalized;
}

export function resolveSince(options: {
  readonly inputSince?: string;
  readonly cursorSince?: string;
  readonly now?: Date;
  readonly lookbackHours: number;
}): string {
  if (options.inputSince && isValidIso(options.inputSince)) return options.inputSince;
  if (options.cursorSince && isValidIso(options.cursorSince)) return options.cursorSince;
  const now = options.now ?? new Date();
  const fallback = new Date(now.getTime() - options.lookbackHours * 60 * 60 * 1000);
  return fallback.toISOString();
}

function getHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: getHeaders(token) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function readCursorFile(options: {
  readonly token: string;
  readonly repository: string;
  readonly dataBranch: string;
  readonly cursorPath: string;
  readonly apiBase?: string;
}): Promise<CursorFile | undefined> {
  const apiBase = options.apiBase ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const url = `${apiBase}/repos/${options.repository}/contents/${options.cursorPath}?ref=${encodeURIComponent(options.dataBranch)}`;
  const res = await fetch(url, { headers: getHeaders(options.token) });

  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to read cursor file (${res.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { content?: string; encoding?: string };
  if (!payload.content || payload.encoding !== "base64") return undefined;
  const raw = Buffer.from(payload.content, "base64").toString("utf-8");
  const parsed = JSON.parse(raw) as CursorFile;
  return parsed;
}

function workflowPathBasename(run: WorkflowRun): string {
  if (!run.path) return "";
  const trimmed = run.path.split("/").pop() ?? "";
  return trimmed.toLowerCase();
}

export function filterRuns(
  runs: readonly WorkflowRun[],
  options: {
    readonly workflows: Set<string>;
    readonly events: Set<string>;
    readonly conclusions: Set<string>;
  },
): CandidateRun[] {
  const out: CandidateRun[] = [];
  for (const run of runs) {
    const createdAt = run.created_at;
    if (!createdAt || !isValidIso(createdAt)) continue;

    const event = (run.event ?? "").toLowerCase();
    if (options.events.size > 0 && !options.events.has(event)) continue;

    const conclusion = (run.conclusion ?? "").toLowerCase();
    if (options.conclusions.size > 0 && !options.conclusions.has(conclusion)) continue;

    if (options.workflows.size > 0) {
      const candidates = [
        (run.name ?? "").toLowerCase(),
        workflowPathBasename(run),
        String(run.workflow_id ?? "").toLowerCase(),
      ];
      if (!candidates.some((c) => c && options.workflows.has(c))) continue;
    }

    out.push({
      id: String(run.id),
      run_attempt: String(run.run_attempt || 1),
      workflow_name: run.name ?? "unknown-workflow",
      event: run.event ?? "unknown",
      created_at: createdAt,
      html_url: run.html_url ?? "",
    });
  }
  return out;
}

export async function listWorkflowRuns(options: {
  readonly token: string;
  readonly repository: string;
  readonly since: string;
  readonly maxRuns: number;
  readonly workflows: Set<string>;
  readonly events: Set<string>;
  readonly conclusions: Set<string>;
  readonly apiBase?: string;
}): Promise<CandidateRun[]> {
  const apiBase = options.apiBase ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const selected: CandidateRun[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${apiBase}/repos/${options.repository}/actions/runs`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("status", "completed");
    url.searchParams.set("created", `>=${options.since}`);

    const payload = await fetchJson<ListRunsResponse>(url.toString(), options.token);
    const runs = payload.workflow_runs ?? [];
    if (runs.length === 0) break;

    const filtered = filterRuns(runs, {
      workflows: options.workflows,
      events: options.events,
      conclusions: options.conclusions,
    });
    selected.push(...filtered);

    if (selected.length >= options.maxRuns) break;
  }

  selected.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (selected.length > options.maxRuns) {
    return selected.slice(selected.length - options.maxRuns);
  }
  return selected;
}

export async function runIngestDiscovery(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const repository = core.getInput("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!repository) {
    throw new Error("repository input is required when GITHUB_REPOSITORY is not set.");
  }

  const dataBranch = core.getInput("data-branch") || "bench-data";
  const cursorPath = normalizeCursorPath(
    core.getInput("cursor-path") || DEFAULT_CURSOR_PATH,
  );
  const commitCursor = core.getBooleanInput("commit-cursor");

  const lookbackHours = Number.parseInt(core.getInput("lookback-hours") || "72", 10);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 30) {
    throw new Error(`lookback-hours must be between 1 and ${24 * 30}`);
  }

  const maxRuns = Number.parseInt(core.getInput("max-runs") || "50", 10);
  if (!Number.isFinite(maxRuns) || maxRuns < 1 || maxRuns > 500) {
    throw new Error("max-runs must be between 1 and 500");
  }

  const workflows = parseCsvSet(core.getInput("workflows") || "");
  const events = parseCsvSet(core.getInput("events") || "");
  const conclusions = parseCsvSet(core.getInput("conclusions") || "");

  const inputSince = core.getInput("since") || undefined;
  if (inputSince && !isValidIso(inputSince)) {
    throw new Error(`since must be a valid ISO timestamp, received "${inputSince}"`);
  }

  let cursor: CursorFile | undefined;
  try {
    cursor = await readCursorFile({ token, repository, dataBranch, cursorPath });
    if (!cursor && cursorPath === DEFAULT_CURSOR_PATH) {
      cursor = await readCursorFile({
        token,
        repository,
        dataBranch,
        cursorPath: LEGACY_CURSOR_PATH,
      });
      if (cursor) {
        core.info(
          `Found legacy ingest cursor at ${dataBranch}:${LEGACY_CURSOR_PATH}; ` +
          `it will be migrated to ${cursorPath}.`,
        );
      }
    }
  } catch (error) {
    core.warning(
      `Could not read ingest cursor at ${dataBranch}:${cursorPath}; using lookback fallback. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const cursorSince = cursor?.latestWorkflowRunCreatedAt ?? cursor?.latestCreatedAt;
  const since = resolveSince({
    inputSince,
    cursorSince,
    lookbackHours,
  });

  const runs = await listWorkflowRuns({
    token,
    repository,
    since,
    maxRuns,
    workflows,
    events,
    conclusions,
  });

  const latestCreatedAt = runs.length > 0
    ? runs[runs.length - 1]?.created_at ?? since
    : since;

  const cursorJson = JSON.stringify(
    {
      cursorKind: "benchkit.ci-run-ingest",
      cursorVersion: 1,
      latestWorkflowRunCreatedAt: latestCreatedAt,
      // Keep writing the legacy key so older readers continue to work.
      latestCreatedAt,
      updatedAt: new Date().toISOString(),
      sourceAction: "benchkit.ingest-ci-runs",
    },
    null,
    2,
  );

  if (!cursorSince && !inputSince) {
    core.info(
      `No explicit since/cursor found. Using bounded first-run lookback: ${lookbackHours}h (${since}).`,
    );
  }
  core.info(`Ingest discovery since ${since}: selected ${runs.length} run(s).`);

  core.setOutput("run-count", String(runs.length));
  core.setOutput("runs-json", JSON.stringify(runs));
  core.setOutput("run-ids-json", JSON.stringify(runs.map((run) => run.id)));
  core.setOutput("since", since);
  core.setOutput("latest-created-at", latestCreatedAt);
  core.setOutput("cursor-json", cursorJson);

  if (commitCursor) {
    await configureGit(token);
    const worktree = await checkoutDataBranch(dataBranch, "benchkit-ci-run-ingest");
    try {
      const outPath = path.join(worktree, cursorPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${cursorJson}\n`);

      await exec.exec("git", ["-C", worktree, "add", cursorPath]);
      const commitExit = await exec.exec(
        "git",
        ["-C", worktree, "commit", "-m", `bench: update ci-run-ingest cursor (${latestCreatedAt})`],
        { ignoreReturnCode: true },
      );

      if (commitExit === 0) {
        await pushWithRetry(worktree, dataBranch, DEFAULT_PUSH_RETRY_COUNT);
        core.info(`Updated ingest cursor at ${dataBranch}:${cursorPath}`);
      } else {
        core.info(`Ingest cursor unchanged at ${dataBranch}:${cursorPath}`);
      }
    } finally {
      await exec.exec("git", ["worktree", "remove", worktree, "--force"], {
        ignoreReturnCode: true,
      });
    }
  } else {
    core.info("commit-cursor=false; skipping cursor write.");
  }

  await core.summary
    .addHeading("Benchkit Ingest Discovery")
    .addRaw(`Repository: \`${repository}\`\n`, true)
    .addRaw(`Since: \`${since}\`\n`, true)
    .addRaw(`Selected runs: **${runs.length}**\n`, true)
    .write();
}
