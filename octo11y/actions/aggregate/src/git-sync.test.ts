import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitAllowFailure(cwd: string, ...args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("aggregate branch sync", () => {
  it("force-fetches bench-data over a diverged local branch after a failed push", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchkit-aggregate-sync-"));
    tempDirs.push(root);

    const remote = path.join(root, "remote.git");
    const writer = path.join(root, "writer");
    const aggregate = path.join(root, "aggregate");
    const aggregateWorktree = path.join(root, "aggregate-worktree");

    git(root, "init", "--bare", remote);
    git(root, "clone", remote, writer);
    git(writer, "config", "user.name", "Benchkit Test");
    git(writer, "config", "user.email", "benchkit@example.com");

    writeFile(writer, "README.md", "seed\n");
    git(writer, "add", "README.md");
    git(writer, "commit", "-m", "seed main");
    git(writer, "push", "origin", "HEAD:main");

    git(writer, "checkout", "--orphan", "bench-data");
    git(writer, "rm", "-rf", ".");
    writeFile(writer, "data/runs/run-1.json", "{\"run\":1}\n");
    git(writer, "add", "data/runs/run-1.json");
    git(writer, "commit", "-m", "seed bench-data");
    git(writer, "push", "origin", "bench-data");

    git(root, "clone", remote, aggregate);
    git(aggregate, "config", "user.name", "Benchkit Test");
    git(aggregate, "config", "user.email", "benchkit@example.com");
    git(aggregate, "fetch", "origin", "+bench-data:bench-data");

    git(aggregate, "worktree", "add", aggregateWorktree, "bench-data");
    writeFile(aggregateWorktree, "data/index.json", "{\"local\":true}\n");
    git(aggregateWorktree, "add", "data/index.json");
    git(aggregateWorktree, "commit", "-m", "local aggregate commit");
    git(aggregate, "worktree", "remove", aggregateWorktree, "--force");

    git(writer, "checkout", "bench-data");
    writeFile(writer, "data/runs/run-2.json", "{\"run\":2}\n");
    git(writer, "add", "data/runs/run-2.json");
    git(writer, "commit", "-m", "remote stash commit");
    git(writer, "push", "origin", "bench-data");

    const plainFetch = gitAllowFailure(aggregate, "fetch", "origin", "bench-data:bench-data");
    assert.notEqual(plainFetch.status, 0);
    assert.match(plainFetch.stderr, /\[rejected\]|non-fast-forward/i);

    const forcedFetch = gitAllowFailure(aggregate, "fetch", "origin", "+bench-data:bench-data");
    assert.equal(forcedFetch.status, 0, forcedFetch.stderr);
    assert.equal(
      git(aggregate, "rev-parse", "bench-data"),
      git(writer, "rev-parse", "origin/bench-data"),
    );
  });
});
