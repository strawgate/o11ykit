import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as github from "@actions/github";
import * as os from "node:os";
import * as path from "node:path";
import { runComparison } from "./compare-action.js";
import type { Format } from "@benchkit/format";
import { DEFAULT_DATA_BRANCH } from "@benchkit/format";

async function run(): Promise<void> {
  const resultsPattern = core.getInput("results", { required: true });
  const format = (core.getInput("format") || "auto") as Format;
  const dataBranch = core.getInput("data-branch") || DEFAULT_DATA_BRANCH;
  const baselineRuns = parseInt(core.getInput("baseline-runs") || "5", 10);
  const threshold = parseFloat(core.getInput("threshold") || "5");
  const matrixPolicyInput = core.getInput("matrix-policy");
  const failOnRegression = core.getBooleanInput("fail-on-regression");
  const commentOnPr = core.getBooleanInput("comment-on-pr");
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);

  const globber = await glob.create(resultsPattern);
  const files = await globber.glob();
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${resultsPattern}`);
  }
  core.info(`Found ${files.length} result file(s)`);

  function setMatrixOutputs(result: {
    hasRegression: boolean;
    hasRequiredFailure: boolean;
    missingResultCount: number;
    requiredPassedCount: number;
    requiredFailedCount: number;
    probeFailedCount: number;
    matrixSummaryJson: string;
    markdown: string;
  }): void {
    core.setOutput("has-regression", String(result.hasRegression));
    core.setOutput("has-required-failure", String(result.hasRequiredFailure));
    core.setOutput("missing-result-count", String(result.missingResultCount));
    core.setOutput("required-passed-count", String(result.requiredPassedCount));
    core.setOutput("required-failed-count", String(result.requiredFailedCount));
    core.setOutput("probe-failed-count", String(result.probeFailedCount));
    core.setOutput("matrix-summary-json", result.matrixSummaryJson);
    core.setOutput("summary", result.markdown);
  }

  const worktree = await fetchDataBranch(dataBranch, token);
  if (!worktree) {
    const markdown = "No baseline data branch found. Skipping comparison.";
    core.warning(markdown);
    setMatrixOutputs({
      hasRegression: false,
      hasRequiredFailure: false,
      missingResultCount: 0,
      requiredPassedCount: 0,
      requiredFailedCount: 0,
      probeFailedCount: 0,
      matrixSummaryJson: "",
      markdown,
    });
    await core.summary.addRaw(markdown, true).write();
    return;
  }

  try {
    const runsDir = path.join(worktree, "data", "runs");
    const result = runComparison({
      files,
      format,
      runsDir,
      baselineRuns,
      threshold,
      matrixPolicyInput,
      currentCommit: process.env.GITHUB_SHA,
      currentRef: process.env.GITHUB_REF,
    });

    setMatrixOutputs(result);
    await core.summary.addRaw(result.markdown, true).write();

    if (commentOnPr && github.context.payload.pull_request) {
      await postPrComment(token, result.markdown);
    } else if (commentOnPr) {
      core.info("Not a pull request event — skipping PR comment.");
    }

    if (failOnRegression) {
      if (matrixPolicyInput) {
        if (result.hasRequiredFailure) {
          core.setFailed("Required benchmark lane failure detected. See job summary for details.");
        }
      } else if (result.hasRegression) {
        core.setFailed("Benchmark regression detected. See job summary for details.");
      }
    }
  } finally {
    await exec.exec("git", ["worktree", "remove", worktree, "--force"], { ignoreReturnCode: true });
  }
}

async function fetchDataBranch(dataBranch: string, token: string): Promise<string | null> {
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  await exec.exec("git", [
    "config", "--local",
    "http.https://github.com/.extraheader",
    `AUTHORIZATION: basic ${basicAuth}`,
  ]);

  const worktree = path.join(os.tmpdir(), `benchkit-compare-${Date.now()}`);
  const fetchCode = await exec.exec(
    "git",
    ["fetch", "origin", `${dataBranch}:${dataBranch}`],
    { ignoreReturnCode: true },
  );
  if (fetchCode !== 0) {
    return null;
  }

  await exec.exec("git", ["worktree", "add", worktree, dataBranch]);
  return worktree;
}

async function postPrComment(token: string, body: string): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const pullNumber = github.context.payload.pull_request?.number;
  if (!pullNumber) return;

  const marker = "<!-- benchkit-compare -->";
  const commentBody = `${marker}\n${body}`;
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });

  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: commentBody,
    });
    core.info(`Updated existing PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: commentBody,
    });
    core.info("Created new PR comment");
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
