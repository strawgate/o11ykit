import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFetchFailure } from "./git-fetch.js";

describe("classifyFetchFailure", () => {
  it("returns guidance when git fetch refuses because the branch is checked out", () => {
    const stderr = [
      "fatal: refusing to fetch into branch 'bench-data' checked out",
      "in repository '/home/runner/work/repo/repo'",
    ].join("\n");

    const result = classifyFetchFailure("bench-data", stderr);
    assert.equal(result.kind, "checked-out");
    assert.match(result.message, /Remove the 'ref: bench-data' input from your actions\/checkout step/);
  });

  it("detects a missing remote branch", () => {
    assert.deepEqual(
      classifyFetchFailure("bench-data", "fatal: couldn't find remote ref bench-data"),
      { kind: "branch-missing" },
    );
  });

  it("treats unrelated fetch failures as hard errors", () => {
    assert.deepEqual(
      classifyFetchFailure("bench-data", "fatal: could not read Username for 'https://github.com'"),
      { kind: "other" },
    );
  });
});
