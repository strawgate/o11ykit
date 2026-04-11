import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPushFailure } from "./git-push.js";

describe("classifyPushFailure", () => {
  it("detects non-fast-forward push rejection", () => {
    const stderr = [
      "error: failed to push some refs to 'https://github.com/strawgate/octo11y.git'",
      "hint: Updates were rejected because the remote contains work that you do not have locally.",
    ].join("\n");

    assert.deepEqual(classifyPushFailure(stderr), { kind: "non-fast-forward" });
  });

  it("detects fetch-first push rejection", () => {
    const stderr = [
      "error: failed to push some refs to 'https://github.com/strawgate/octo11y.git'",
      "hint: Updates were rejected because the tip of your current branch is behind",
      "hint: its remote counterpart. Integrate the remote changes (e.g. 'git pull ...') before pushing again.",
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
      "hint: fetch first",
    ].join("\n");

    assert.deepEqual(classifyPushFailure(stderr), { kind: "non-fast-forward" });
  });

  it("treats unrelated push failures as hard errors", () => {
    assert.deepEqual(
      classifyPushFailure("fatal: could not read Username for 'https://github.com'"),
      { kind: "other" },
    );
  });
});
