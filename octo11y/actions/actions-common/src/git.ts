/**
 * Shared git helpers for Benchkit GitHub Actions.
 *
 * Configures git auth, checks out the data branch into a worktree,
 * and pushes with retry + rebase.
 */

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DATA_BRANCH } from "@benchkit/format";
import { computeRetryDelayMs, DEFAULT_PUSH_RETRY_COUNT, sleep } from "@octo11y/core";

export { DEFAULT_DATA_BRANCH, DEFAULT_PUSH_RETRY_COUNT };
const DEFAULT_FETCH_RETRY_COUNT = 5;

/**
 * Detect git ref-update races (common in concurrent CI branch writers).
 */
function isConcurrentRefUpdateError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("cannot lock ref")
    || normalized.includes("unable to update local ref")
    || normalized.includes("failed to update ref")
    || (normalized.includes(" is at ") && normalized.includes(" expected "))
  );
}

/**
 * Configure git user identity and token-based auth.
 */
export async function configureGit(token: string): Promise<void> {
  await exec.exec("git", ["config", "user.name", "github-actions[bot]"]);
  await exec.exec("git", [
    "config", "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  await exec.exec("git", [
    "config", "--local",
    "http.https://github.com/.extraheader",
    `AUTHORIZATION: basic ${basicAuth}`,
  ]);
}

/**
 * Fetch the data branch and check it out in a temporary worktree.
 * Creates an orphan branch if it does not exist.
 *
 * @param dataBranch The branch name (defaults to bench-data).
 * @param prefix     Worktree directory prefix for uniqueness.
 * @returns Path to the worktree directory.
 */
export async function checkoutDataBranch(
  dataBranch: string = DEFAULT_DATA_BRANCH,
  prefix = "benchkit-data",
): Promise<string> {
  const worktree = path.join(os.tmpdir(), `${prefix}-${Date.now()}`);

  let fetchCode = 1;
  let fetchStderr = "";
  for (let attempt = 1; attempt <= DEFAULT_FETCH_RETRY_COUNT; attempt += 1) {
    fetchStderr = "";
    fetchCode = await exec.exec(
      "git", ["fetch", "origin", `+${dataBranch}:${dataBranch}`],
      {
        ignoreReturnCode: true,
        listeners: {
          stderr: (data: Buffer) => { fetchStderr += data.toString(); },
        },
      },
    );
    if (fetchCode === 0) break;

    if (fetchStderr.includes("couldn't find remote ref")) {
      core.info(`Branch '${dataBranch}' does not exist; creating orphan branch.`);
      await exec.exec("git", ["worktree", "add", "--detach", worktree]);
      await exec.exec("git", ["-C", worktree, "checkout", "--orphan", dataBranch]);
      await exec.exec("git", ["-C", worktree, "rm", "-rf", "."], { ignoreReturnCode: true });
      return worktree;
    }
    if (fetchStderr.includes("refusing to fetch into branch") && fetchStderr.includes("checked out")) {
      throw new Error(
        `Cannot operate on '${dataBranch}': it is already checked out at the current working directory. `
        + `Remove the 'ref: ${dataBranch}' input from your actions/checkout step — `
        + "the action fetches the data branch into its own worktree.",
      );
    }
    if (isConcurrentRefUpdateError(fetchStderr) && attempt < DEFAULT_FETCH_RETRY_COUNT) {
      const delayMs = computeRetryDelayMs(Math.random());
      core.warning(
        `Fetch of '${dataBranch}' hit a concurrent ref update (attempt ${attempt}/${DEFAULT_FETCH_RETRY_COUNT}); retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
      continue;
    }
    break;
  }
  if (fetchCode !== 0) {
    throw new Error(
      `Failed to fetch '${dataBranch}' from origin: ${fetchStderr.trim() || `git fetch exited with code ${fetchCode}`}`,
    );
  }

  await exec.exec("git", ["worktree", "add", worktree, dataBranch]);
  return worktree;
}

/**
 * Push the worktree branch to origin with retry + rebase on conflict.
 *
 * @param worktree   Path to the git worktree.
 * @param dataBranch Branch name to push.
 * @param maxRetries Maximum push attempts.
 */
export async function pushWithRetry(
  worktree: string,
  dataBranch: string,
  maxRetries: number = DEFAULT_PUSH_RETRY_COUNT,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let pushStderr = "";
    const pushCode = await exec.exec(
      "git", ["-C", worktree, "push", "origin", `HEAD:${dataBranch}`],
      {
        ignoreReturnCode: true,
        listeners: {
          stderr: (data: Buffer) => { pushStderr += data.toString(); },
        },
      },
    );

    if (pushCode === 0) return;

    const isConflict =
      pushStderr.includes("non-fast-forward")
      || pushStderr.includes("fetch first")
      || pushStderr.includes("Updates were rejected")
      || isConcurrentRefUpdateError(pushStderr);

    if (isConflict && attempt < maxRetries) {
      const delayMs = computeRetryDelayMs(Math.random());
      core.warning(
        `Push rejected by concurrent update (attempt ${attempt}/${maxRetries}); retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
      await exec.exec("git", ["-C", worktree, "fetch", "origin", dataBranch]);
      await exec.exec("git", ["-C", worktree, "rebase", `origin/${dataBranch}`]);
      continue;
    }

    throw new Error(
      `Failed to push to '${dataBranch}': ${pushStderr.trim() || `git push exited with code ${pushCode}`}`,
    );
  }
}
