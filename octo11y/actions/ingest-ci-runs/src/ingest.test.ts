import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterRuns, resolveSince, type WorkflowRun } from "./ingest.js";

describe("resolveSince", () => {
  it("prefers explicit since", () => {
    const resolved = resolveSince({
      inputSince: "2026-01-02T03:04:05.000Z",
      cursorSince: "2026-01-01T00:00:00.000Z",
      lookbackHours: 72,
      now: new Date("2026-04-01T00:00:00.000Z"),
    });
    assert.equal(resolved, "2026-01-02T03:04:05.000Z");
  });

  it("falls back to cursor", () => {
    const resolved = resolveSince({
      cursorSince: "2026-01-01T00:00:00.000Z",
      lookbackHours: 72,
      now: new Date("2026-04-01T00:00:00.000Z"),
    });
    assert.equal(resolved, "2026-01-01T00:00:00.000Z");
  });

  it("uses bounded lookback when no input or cursor", () => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    const resolved = resolveSince({ lookbackHours: 24, now });
    assert.equal(resolved, "2026-03-31T00:00:00.000Z");
  });

  it("ignores invalid cursor values and falls back to lookback", () => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    const resolved = resolveSince({
      cursorSince: "not-a-date",
      lookbackHours: 12,
      now,
    });
    assert.equal(resolved, "2026-03-31T12:00:00.000Z");
  });
});

describe("filterRuns", () => {
  const runs: WorkflowRun[] = [
    {
      id: 101,
      run_attempt: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      workflow_id: 7,
      event: "push",
      status: "completed",
      conclusion: "success",
      created_at: "2026-04-01T02:00:00.000Z",
      html_url: "https://example/101",
    },
    {
      id: 102,
      run_attempt: 1,
      name: "Pages",
      path: ".github/workflows/pages.yml",
      workflow_id: 8,
      event: "schedule",
      status: "completed",
      conclusion: "failure",
      created_at: "2026-04-01T03:00:00.000Z",
      html_url: "https://example/102",
    },
  ];

  it("includes all workflows when workflow filter is empty", () => {
    const selected = filterRuns(runs, {
      workflows: new Set(),
      events: new Set(["push", "schedule"]),
      conclusions: new Set(["success", "failure"]),
    });
    assert.equal(selected.length, 2);
  });

  it("filters by conclusion and workflow name", () => {
    const selected = filterRuns(runs, {
      workflows: new Set(["ci"]),
      events: new Set(["push", "schedule"]),
      conclusions: new Set(["success"]),
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.id, "101");
  });
});
