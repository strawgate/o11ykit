import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildOtlpResult } from "@benchkit/format";
import type { OtlpResultBenchmark, OtlpResultMetric } from "@benchkit/format";
import * as fs from "node:fs";

// ---- Types ----------------------------------------------------------------

export type MetricName =
  | "stars"
  | "forks"
  | "open-issues"
  | "open-prs"
  | "contributors"
  | "releases"
  | "repo-size-kb"
  | "watchers"
  | "network-count"
  | "workflow-success-pct"
  // Traffic API (needs admin:read or administration:read)
  | "page-views"
  | "unique-visitors"
  | "clones"
  | "unique-cloners"
  // Statistics API
  | "weekly-commits"
  | "weekly-additions"
  | "weekly-deletions"
  // Velocity metrics
  | "avg-issue-close-days"
  | "median-issue-close-days"
  | "avg-pr-merge-hours"
  | "median-pr-merge-hours"
  // Security metrics (need security_events permission)
  | "dependabot-alerts"
  | "code-scanning-alerts"
  // Language breakdown (dynamic — emits one metric per language)
  | "languages";

export const ALL_METRICS: readonly MetricName[] = [
  "stars",
  "forks",
  "open-issues",
  "open-prs",
  "contributors",
  "releases",
  "repo-size-kb",
  "watchers",
  "network-count",
  "workflow-success-pct",
  "page-views",
  "unique-visitors",
  "clones",
  "unique-cloners",
  "weekly-commits",
  "weekly-additions",
  "weekly-deletions",
  "avg-issue-close-days",
  "median-issue-close-days",
  "avg-pr-merge-hours",
  "median-pr-merge-hours",
  "dependabot-alerts",
  "code-scanning-alerts",
  "languages",
] as const;

/** Metrics that expand to multiple OTLP metrics at collection time. */
const MULTI_VALUE_METRICS: MetricName[] = ["languages"];

interface MetricDefinition {
  unit: string;
  direction: "bigger_is_better" | "smaller_is_better";
}

const METRIC_DEFS: Record<Exclude<MetricName, "languages">, MetricDefinition> = {
  "stars":                    { unit: "count", direction: "bigger_is_better" },
  "forks":                    { unit: "count", direction: "bigger_is_better" },
  "open-issues":              { unit: "count", direction: "smaller_is_better" },
  "open-prs":                 { unit: "count", direction: "smaller_is_better" },
  "contributors":             { unit: "count", direction: "bigger_is_better" },
  "releases":                 { unit: "count", direction: "bigger_is_better" },
  "repo-size-kb":             { unit: "KB",    direction: "smaller_is_better" },
  "watchers":                 { unit: "count", direction: "bigger_is_better" },
  "network-count":            { unit: "count", direction: "bigger_is_better" },
  "workflow-success-pct":     { unit: "%",     direction: "bigger_is_better" },
  "page-views":               { unit: "count", direction: "bigger_is_better" },
  "unique-visitors":          { unit: "count", direction: "bigger_is_better" },
  "clones":                   { unit: "count", direction: "bigger_is_better" },
  "unique-cloners":           { unit: "count", direction: "bigger_is_better" },
  "weekly-commits":           { unit: "count", direction: "bigger_is_better" },
  "weekly-additions":         { unit: "lines", direction: "bigger_is_better" },
  "weekly-deletions":         { unit: "lines", direction: "smaller_is_better" },
  "avg-issue-close-days":     { unit: "days",  direction: "smaller_is_better" },
  "median-issue-close-days":  { unit: "days",  direction: "smaller_is_better" },
  "avg-pr-merge-hours":       { unit: "hours", direction: "smaller_is_better" },
  "median-pr-merge-hours":    { unit: "hours", direction: "smaller_is_better" },
  "dependabot-alerts":        { unit: "count", direction: "smaller_is_better" },
  "code-scanning-alerts":     { unit: "count", direction: "smaller_is_better" },
};

export interface RepoStatsOptions {
  token: string;
  repository: string;
  scenario: string;
  metrics: MetricName[];
  outputFile: string;
  workflowRunCount: number;
}

// ---- Input parsing --------------------------------------------------------

export function parseMetricNames(input: string): MetricName[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "") {
    return [...ALL_METRICS];
  }

  const names = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const valid: MetricName[] = [];
  for (const name of names) {
    if (!ALL_METRICS.includes(name as MetricName)) {
      throw new Error(
        `Unknown metric "${name}". Available: ${ALL_METRICS.join(", ")}`,
      );
    }
    valid.push(name as MetricName);
  }
  if (valid.length === 0) {
    throw new Error("No metrics selected.");
  }
  return valid;
}

export function parseOptions(): RepoStatsOptions {
  const token = core.getInput("github-token", { required: true });
  const repository = core.getInput("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!repository.includes("/")) {
    throw new Error(`Invalid repository "${repository}". Expected owner/repo.`);
  }

  const scenario =
    core.getInput("scenario") || repository.split("/")[1] || "repo-stats";
  const metrics = parseMetricNames(core.getInput("metrics") || "all");
  const outputFile = core.getInput("output-file") || "repo-stats.json";
  const workflowRunCount = parsePositiveInt(
    core.getInput("workflow-run-count") || "30",
    "workflow-run-count",
  );

  return { token, repository, scenario, metrics, outputFile, workflowRunCount };
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer, got "${value}".`);
  }
  return n;
}

// ---- Metric collectors ----------------------------------------------------

type Octokit = ReturnType<typeof github.getOctokit>;

interface CollectorContext {
  octokit: Octokit;
  owner: string;
  repo: string;
  workflowRunCount: number;
}

type Collector = (ctx: CollectorContext) => Promise<number>;

async function collectStars(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  return data.stargazers_count;
}

async function collectForks(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  return data.forks_count;
}

async function collectOpenIssues(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  // GitHub's open_issues_count includes PRs; subtract open PRs for accuracy
  return data.open_issues_count;
}

async function collectOpenPrs(ctx: CollectorContext): Promise<number> {
  const resp = await ctx.octokit.rest.search.issuesAndPullRequests({
    q: `repo:${ctx.owner}/${ctx.repo} is:pr is:open`,
    per_page: 1,
  });
  return resp.data.total_count;
}

async function collectContributors(ctx: CollectorContext): Promise<number> {
  // Paginate to count all contributors (GitHub caps per_page at 100)
  let count = 0;
  let page = 1;
  const perPage = 100;
  for (;;) {
    const { data } = await ctx.octokit.rest.repos.listContributors({
      owner: ctx.owner,
      repo: ctx.repo,
      per_page: perPage,
      page,
      anon: "false",
    });
    count += data.length;
    if (data.length < perPage) break;
    page++;
  }
  return count;
}

async function collectReleases(ctx: CollectorContext): Promise<number> {
  let count = 0;
  let page = 1;
  const perPage = 100;
  for (;;) {
    const { data } = await ctx.octokit.rest.repos.listReleases({
      owner: ctx.owner,
      repo: ctx.repo,
      per_page: perPage,
      page,
    });
    count += data.length;
    if (data.length < perPage) break;
    page++;
  }
  return count;
}

async function collectRepoSizeKb(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  return data.size;
}

async function collectWatchers(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  return data.subscribers_count;
}

async function collectWorkflowSuccessPct(
  ctx: CollectorContext,
): Promise<number> {
  const { data } = await ctx.octokit.rest.actions.listWorkflowRunsForRepo({
    owner: ctx.owner,
    repo: ctx.repo,
    per_page: Math.min(ctx.workflowRunCount, 100),
  });

  const runs = data.workflow_runs.slice(0, ctx.workflowRunCount);
  if (runs.length === 0) return 0;

  const successes = runs.filter((r) => r.conclusion === "success").length;
  return Math.round((successes / runs.length) * 1000) / 10; // one decimal
}

async function collectNetworkCount(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  return data.network_count ?? 0;
}

// ---- Traffic collectors (need administration:read) ------------------------

async function collectPageViews(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.getViews({
    owner: ctx.owner,
    repo: ctx.repo,
    per: "day",
  });
  return data.count;
}

async function collectUniqueVisitors(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.getViews({
    owner: ctx.owner,
    repo: ctx.repo,
    per: "day",
  });
  return data.uniques;
}

async function collectClones(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.getClones({
    owner: ctx.owner,
    repo: ctx.repo,
    per: "day",
  });
  return data.count;
}

async function collectUniqueCloners(ctx: CollectorContext): Promise<number> {
  const { data } = await ctx.octokit.rest.repos.getClones({
    owner: ctx.owner,
    repo: ctx.repo,
    per: "day",
  });
  return data.uniques;
}

// ---- Statistics collectors ------------------------------------------------

/**
 * Get commits in the most recent week from the commit_activity stats.
 * The stats API may return 202 (computing) on the first call, so we
 * retry once after a short delay.
 */
async function collectWeeklyCommits(ctx: CollectorContext): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await ctx.octokit.rest.repos.getCommitActivityStats({
      owner: ctx.owner,
      repo: ctx.repo,
    });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      return resp.data[resp.data.length - 1].total;
    }
    // 202 means GitHub is computing — wait and retry
    if (resp.status === 202) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return 0;
}

async function collectWeeklyAdditions(ctx: CollectorContext): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await ctx.octokit.rest.repos.getCodeFrequencyStats({
      owner: ctx.owner,
      repo: ctx.repo,
    });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      // Each entry is [week_unix, additions, deletions]
      return resp.data[resp.data.length - 1][1];
    }
    if (resp.status === 202) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return 0;
}

async function collectWeeklyDeletions(ctx: CollectorContext): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await ctx.octokit.rest.repos.getCodeFrequencyStats({
      owner: ctx.owner,
      repo: ctx.repo,
    });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      // Deletions are negative in the API — return absolute value
      return Math.abs(resp.data[resp.data.length - 1][2]);
    }
    if (resp.status === 202) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return 0;
}

// ---- Velocity collectors --------------------------------------------------

/** Compute the median of a sorted numeric array. */
export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Fetch recently closed issues and compute close-time stats. */
async function fetchIssueCloseTimes(ctx: CollectorContext): Promise<number[]> {
  const { data } = await ctx.octokit.rest.issues.listForRepo({
    owner: ctx.owner,
    repo: ctx.repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  // Filter out pull requests (GitHub includes them in the issues endpoint)
  const issues = data.filter((i) => !i.pull_request);
  const durations: number[] = [];
  for (const issue of issues) {
    if (!issue.closed_at) continue;
    const opened = new Date(issue.created_at).getTime();
    const closed = new Date(issue.closed_at).getTime();
    const days = (closed - opened) / (1000 * 60 * 60 * 24);
    if (days >= 0) durations.push(days);
  }
  return durations.sort((a, b) => a - b);
}

async function collectAvgIssueCloseDays(ctx: CollectorContext): Promise<number> {
  const durations = await fetchIssueCloseTimes(ctx);
  if (durations.length === 0) return 0;
  const avg = durations.reduce((s, v) => s + v, 0) / durations.length;
  return Math.round(avg * 10) / 10;
}

async function collectMedianIssueCloseDays(ctx: CollectorContext): Promise<number> {
  const durations = await fetchIssueCloseTimes(ctx);
  return Math.round(median(durations) * 10) / 10;
}

/** Fetch recently merged PRs and compute merge-time stats. */
async function fetchPrMergeTimes(ctx: CollectorContext): Promise<number[]> {
  const { data } = await ctx.octokit.rest.pulls.list({
    owner: ctx.owner,
    repo: ctx.repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  const durations: number[] = [];
  for (const pr of data) {
    if (!pr.merged_at) continue;
    const opened = new Date(pr.created_at).getTime();
    const merged = new Date(pr.merged_at).getTime();
    const hours = (merged - opened) / (1000 * 60 * 60);
    if (hours >= 0) durations.push(hours);
  }
  return durations.sort((a, b) => a - b);
}

async function collectAvgPrMergeHours(ctx: CollectorContext): Promise<number> {
  const durations = await fetchPrMergeTimes(ctx);
  if (durations.length === 0) return 0;
  const avg = durations.reduce((s, v) => s + v, 0) / durations.length;
  return Math.round(avg * 10) / 10;
}

async function collectMedianPrMergeHours(ctx: CollectorContext): Promise<number> {
  const durations = await fetchPrMergeTimes(ctx);
  return Math.round(median(durations) * 10) / 10;
}

// ---- Security collectors (need security_events permission) ----------------

async function collectDependabotAlerts(ctx: CollectorContext): Promise<number> {
  let count = 0;
  let page = 1;
  for (;;) {
    const r = await ctx.octokit.request(
      "GET /repos/{owner}/{repo}/dependabot/alerts",
      { owner: ctx.owner, repo: ctx.repo, state: "open", per_page: 100, page },
    );
    const alerts = r.data as unknown[];
    count += alerts.length;
    if (alerts.length < 100) break;
    page++;
  }
  return count;
}

async function collectCodeScanningAlerts(ctx: CollectorContext): Promise<number> {
  let count = 0;
  let page = 1;
  for (;;) {
    const r = await ctx.octokit.request(
      "GET /repos/{owner}/{repo}/code-scanning/alerts",
      { owner: ctx.owner, repo: ctx.repo, state: "open", per_page: 100, page },
    );
    const alerts = r.data as unknown[];
    count += alerts.length;
    if (alerts.length < 100) break;
    page++;
  }
  return count;
}

// ---- Language collector (multi-value) -------------------------------------

async function collectLanguages(
  ctx: CollectorContext,
): Promise<Record<string, OtlpResultMetric>> {
  const { data } = await ctx.octokit.rest.repos.listLanguages({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  const result: Record<string, OtlpResultMetric> = {};
  for (const [lang, bytes] of Object.entries(data)) {
    const name = `lang_bytes_${lang.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
    result[name] = { value: bytes, unit: "bytes", direction: "bigger_is_better" };
  }
  return result;
}

const COLLECTORS: Record<Exclude<MetricName, "languages">, Collector> = {
  "stars":                   collectStars,
  "forks":                   collectForks,
  "open-issues":             collectOpenIssues,
  "open-prs":                collectOpenPrs,
  "contributors":            collectContributors,
  "releases":                collectReleases,
  "repo-size-kb":            collectRepoSizeKb,
  "watchers":                collectWatchers,
  "network-count":           collectNetworkCount,
  "workflow-success-pct":    collectWorkflowSuccessPct,
  "page-views":              collectPageViews,
  "unique-visitors":         collectUniqueVisitors,
  "clones":                  collectClones,
  "unique-cloners":          collectUniqueCloners,
  "weekly-commits":          collectWeeklyCommits,
  "weekly-additions":        collectWeeklyAdditions,
  "weekly-deletions":        collectWeeklyDeletions,
  "avg-issue-close-days":    collectAvgIssueCloseDays,
  "median-issue-close-days": collectMedianIssueCloseDays,
  "avg-pr-merge-hours":      collectAvgPrMergeHours,
  "median-pr-merge-hours":   collectMedianPrMergeHours,
  "dependabot-alerts":       collectDependabotAlerts,
  "code-scanning-alerts":    collectCodeScanningAlerts,
};

// ---- Core logic -----------------------------------------------------------

/**
 * Collect the requested metrics, avoiding redundant API calls for metrics
 * that share the same endpoint (repos.get).
 */
export async function collectMetrics(
  options: RepoStatsOptions,
): Promise<Record<string, OtlpResultMetric>> {
  const octokit = github.getOctokit(options.token);
  const [owner, repo] = options.repository.split("/");
  const ctx: CollectorContext = {
    octokit,
    owner,
    repo,
    workflowRunCount: options.workflowRunCount,
  };

  // Metrics backed by repos.get — fetch once and reuse
  const repoGetMetrics: MetricName[] = [
    "stars", "forks", "open-issues", "repo-size-kb", "watchers", "network-count",
  ];
  const needsRepoGet = options.metrics.some((m) => repoGetMetrics.includes(m));
  let repoData: Awaited<ReturnType<typeof octokit.rest.repos.get>>["data"] | undefined;
  if (needsRepoGet) {
    const resp = await octokit.rest.repos.get({ owner, repo });
    repoData = resp.data;
  }

  // Traffic views — cache for page-views + unique-visitors
  const trafficViewMetrics: MetricName[] = ["page-views", "unique-visitors"];
  const needsTrafficViews = options.metrics.some((m) => trafficViewMetrics.includes(m));
  let trafficViews: { count: number; uniques: number } | undefined;
  if (needsTrafficViews) {
    try {
      const resp = await octokit.rest.repos.getViews({ owner, repo, per: "day" });
      trafficViews = { count: resp.data.count, uniques: resp.data.uniques };
    } catch (err) {
      core.warning(`Traffic views API failed (needs admin read access): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Traffic clones — cache for clones + unique-cloners
  const trafficCloneMetrics: MetricName[] = ["clones", "unique-cloners"];
  const needsTrafficClones = options.metrics.some((m) => trafficCloneMetrics.includes(m));
  let trafficClones: { count: number; uniques: number } | undefined;
  if (needsTrafficClones) {
    try {
      const resp = await octokit.rest.repos.getClones({ owner, repo, per: "day" });
      trafficClones = { count: resp.data.count, uniques: resp.data.uniques };
    } catch (err) {
      core.warning(`Traffic clones API failed (needs admin read access): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Code frequency stats — cache for weekly-additions + weekly-deletions
  const codeFreqMetrics: MetricName[] = ["weekly-additions", "weekly-deletions"];
  const needsCodeFreq = options.metrics.some((m) => codeFreqMetrics.includes(m));
  let codeFreqLatest: [number, number, number] | undefined;
  if (needsCodeFreq) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await octokit.rest.repos.getCodeFrequencyStats({ owner, repo });
      if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
        codeFreqLatest = resp.data[resp.data.length - 1] as [number, number, number];
        break;
      }
      if (resp.status === 202) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // Issue velocity — cache for avg + median issue close time
  const issueVelocityMetrics: MetricName[] = ["avg-issue-close-days", "median-issue-close-days"];
  const needsIssueVelocity = options.metrics.some((m) => issueVelocityMetrics.includes(m));
  let issueCloseTimes: number[] | undefined;
  if (needsIssueVelocity) {
    issueCloseTimes = await fetchIssueCloseTimes(ctx);
  }

  // PR velocity — cache for avg + median merge time
  const prVelocityMetrics: MetricName[] = ["avg-pr-merge-hours", "median-pr-merge-hours"];
  const needsPrVelocity = options.metrics.some((m) => prVelocityMetrics.includes(m));
  let prMergeTimes: number[] | undefined;
  if (needsPrVelocity) {
    prMergeTimes = await fetchPrMergeTimes(ctx);
  }

  // Security metrics — attempt and cache permission status
  const securityMetrics: MetricName[] = ["dependabot-alerts", "code-scanning-alerts"];
  const needsSecurity = options.metrics.some((m) => securityMetrics.includes(m));
  let securityAvailable = true;
  if (needsSecurity) {
    // Probe with a lightweight call to check permissions
    try {
      await octokit.request(
        "GET /repos/{owner}/{repo}/dependabot/alerts",
        { owner, repo, state: "open", per_page: 1 },
      );
    } catch {
      core.warning("Security APIs not available (needs security_events permission) — skipping dependabot-alerts and code-scanning-alerts");
      securityAvailable = false;
    }
  }

  const result: Record<string, OtlpResultMetric> = {};

  for (const metric of options.metrics) {
    // Multi-value metrics produce multiple OTLP metrics
    if (MULTI_VALUE_METRICS.includes(metric)) {
      if (metric === "languages") {
        try {
          const langMetrics = await collectLanguages(ctx);
          for (const [name, m] of Object.entries(langMetrics)) {
            core.info(`${name}: ${m.value} ${m.unit}`);
            result[name] = m;
          }
        } catch (err) {
          core.warning(`Languages API failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      continue;
    }

    const singleMetric = metric as Exclude<MetricName, "languages">;
    const def = METRIC_DEFS[singleMetric];
    // Use cached data when available to avoid redundant API calls
    let value: number | undefined;
    if (repoData && repoGetMetrics.includes(metric)) {
      switch (metric) {
        case "stars":         value = repoData.stargazers_count; break;
        case "forks":         value = repoData.forks_count; break;
        case "open-issues":   value = repoData.open_issues_count; break;
        case "repo-size-kb":  value = repoData.size; break;
        case "watchers":      value = repoData.subscribers_count; break;
        case "network-count": value = repoData.network_count ?? 0; break;
      }
    } else if (trafficViews && trafficViewMetrics.includes(metric)) {
      value = metric === "page-views" ? trafficViews.count : trafficViews.uniques;
    } else if (trafficClones && trafficCloneMetrics.includes(metric)) {
      value = metric === "clones" ? trafficClones.count : trafficClones.uniques;
    } else if (codeFreqLatest && codeFreqMetrics.includes(metric)) {
      value = metric === "weekly-additions"
        ? codeFreqLatest[1]
        : Math.abs(codeFreqLatest[2]);
    } else if (issueCloseTimes && issueVelocityMetrics.includes(metric)) {
      if (metric === "avg-issue-close-days") {
        const avg = issueCloseTimes.length === 0
          ? 0
          : issueCloseTimes.reduce((s, v) => s + v, 0) / issueCloseTimes.length;
        value = Math.round(avg * 10) / 10;
      } else {
        value = Math.round(median(issueCloseTimes) * 10) / 10;
      }
    } else if (prMergeTimes && prVelocityMetrics.includes(metric)) {
      if (metric === "avg-pr-merge-hours") {
        const avg = prMergeTimes.length === 0
          ? 0
          : prMergeTimes.reduce((s, v) => s + v, 0) / prMergeTimes.length;
        value = Math.round(avg * 10) / 10;
      } else {
        value = Math.round(median(prMergeTimes) * 10) / 10;
      }
    }

    // Fall back to individual collector if no cached value
    if (value === undefined) {
      // Traffic metrics that failed auth — skip gracefully
      if (
        (trafficViewMetrics.includes(metric) && !trafficViews) ||
        (trafficCloneMetrics.includes(metric) && !trafficClones)
      ) {
        core.info(`Skipping ${metric} (traffic API not available)`);
        continue;
      }
      // Security metrics that failed auth — skip gracefully
      if (securityMetrics.includes(metric) && !securityAvailable) {
        core.info(`Skipping ${metric} (security API not available)`);
        continue;
      }
      value = await COLLECTORS[singleMetric](ctx);
    }

    // Normalize metric name to underscore form for OTLP convention
    const otlpName = metric.replace(/-/g, "_");
    core.info(`${otlpName}: ${value} ${def.unit}`);
    result[otlpName] = {
      value,
      unit: def.unit,
      direction: def.direction,
    };
  }

  return result;
}

/**
 * Build the OTLP metrics document and write it to disk.
 */
export function writeOtlpFile(
  metrics: Record<string, OtlpResultMetric>,
  scenario: string,
  outputFile: string,
): void {
  const benchmark: OtlpResultBenchmark = {
    name: scenario,
    metrics,
  };

  const doc = buildOtlpResult({
    benchmarks: [benchmark],
    context: { sourceFormat: "otlp" },
  });

  fs.writeFileSync(outputFile, JSON.stringify(doc, null, 2));
}

// ---- Action entry point ---------------------------------------------------

export async function runRepoStatsAction(): Promise<void> {
  const options = parseOptions();

  core.info(
    `Collecting ${options.metrics.length} metric(s) for ${options.repository}`,
  );

  const metrics = await collectMetrics(options);
  writeOtlpFile(metrics, options.scenario, options.outputFile);

  core.info(`Wrote ${options.outputFile}`);
  core.setOutput("results-file", options.outputFile);
}
