import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBaseline, autoSelectRun } from "./RunDashboard.js";
import type { RefIndexEntry, PrIndexEntry, IndexFile } from "@octo11y/core";

describe("RunDashboard helpers", () => {
  describe("resolveBaseline", () => {
    const refIndex: RefIndexEntry[] = [
      { ref: "refs/heads/main", latestRunId: "run-main-1", latestTimestamp: "2026-04-01T00:00:00Z", runCount: 3 },
      { ref: "refs/heads/dev", latestRunId: "run-dev-1", latestTimestamp: "2026-04-02T00:00:00Z", runCount: 1 },
    ];

    it("resolves baseline from default branch", () => {
      assert.equal(resolveBaseline(refIndex, "main"), "run-main-1");
    });

    it("resolves baseline from custom branch", () => {
      assert.equal(resolveBaseline(refIndex, "dev"), "run-dev-1");
    });

    it("returns null when branch not found", () => {
      assert.equal(resolveBaseline(refIndex, "release"), null);
    });

    it("returns null for empty refIndex", () => {
      assert.equal(resolveBaseline([], "main"), null);
    });
  });

  describe("autoSelectRun", () => {
    const prIndex: PrIndexEntry[] = [
      { prNumber: 10, ref: "refs/pull/10/merge", latestRunId: "pr-10-old", latestTimestamp: "2026-04-01T00:00:00Z", runCount: 1 },
      { prNumber: 20, ref: "refs/pull/20/merge", latestRunId: "pr-20-new", latestTimestamp: "2026-04-02T00:00:00Z", runCount: 2 },
    ];

    const refIndex: RefIndexEntry[] = [
      { ref: "refs/heads/main", latestRunId: "ref-main", latestTimestamp: "2026-04-01T00:00:00Z", runCount: 5 },
      { ref: "refs/heads/dev", latestRunId: "ref-dev", latestTimestamp: "2026-04-03T00:00:00Z", runCount: 1 },
    ];

    const index: IndexFile = {
      runs: [
        { id: "run-1", timestamp: "2026-04-01T00:00:00Z" },
        { id: "run-2", timestamp: "2026-04-02T00:00:00Z" },
      ],
    };

    it("prefers latest PR when PRs exist", () => {
      assert.equal(autoSelectRun(prIndex, refIndex, index), "pr-20-new");
    });

    it("falls back to latest ref when no PRs", () => {
      assert.equal(autoSelectRun([], refIndex, index), "ref-dev");
    });

    it("falls back to first index run when no PRs or refs", () => {
      assert.equal(autoSelectRun([], [], index), "run-1");
    });

    it("falls back to first index run when undefined PRs/refs", () => {
      assert.equal(autoSelectRun(undefined, undefined, index), "run-1");
    });

    it("returns null when everything is empty", () => {
      assert.equal(autoSelectRun([], [], { runs: [] }), null);
    });

    it("returns null when all undefined", () => {
      assert.equal(autoSelectRun(undefined, undefined, undefined), null);
    });
  });
});
