import { describe, expect, it } from "vitest";

import {
  DRAIN_DEFAULT_CONFIG,
  Drain,
  mergeTemplate,
  PARAM_STR,
  similarity,
  tokenize,
} from "../src/drain.js";

describe("tokenize", () => {
  it("splits on whitespace runs", () => {
    expect(tokenize("foo   bar  baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns an empty array for empty/whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("similarity", () => {
  it("returns 1.0 for identical token lists with no params", () => {
    const [sim, paramCount] = similarity(["a", "b", "c"], ["a", "b", "c"]);
    expect(sim).toBe(1);
    expect(paramCount).toBe(0);
  });

  it("treats wildcard positions as non-matches in the numerator", () => {
    const [sim, paramCount] = similarity([PARAM_STR, "b", "c"], ["a", "b", "c"]);
    expect(sim).toBeCloseTo(2 / 3);
    expect(paramCount).toBe(1);
  });

  it("returns 0 when no positions match", () => {
    const [sim] = similarity(["a", "b", "c"], ["x", "y", "z"]);
    expect(sim).toBe(0);
  });
});

describe("mergeTemplate", () => {
  it("replaces mismatched positions with PARAM_STR and reports change", () => {
    const tpl = ["GET", "/api/users/123", "200"];
    const changed = mergeTemplate(tpl, ["GET", "/api/users/456", "200"]);
    expect(tpl).toEqual(["GET", PARAM_STR, "200"]);
    expect(changed).toBe(true);
  });

  it("returns false when nothing changes", () => {
    const tpl = ["GET", "/health", "200"];
    const changed = mergeTemplate(tpl, ["GET", "/health", "200"]);
    expect(changed).toBe(false);
  });
});

describe("Drain.matchOrAdd", () => {
  it("creates a new cluster for the first line of a shape", () => {
    const drain = new Drain();
    const r = drain.matchOrAdd("user 42 logged in");
    expect(r.isNew).toBe(true);
    expect(r.templateId).toBe(1);
    expect(drain.templateCount()).toBe(1);
  });

  it("matches a similar second line and merges variable positions", () => {
    const drain = new Drain();
    const a = drain.matchOrAdd("user 42 logged in");
    const b = drain.matchOrAdd("user 99 logged in");
    expect(b.isNew).toBe(false);
    expect(b.templateId).toBe(a.templateId);
    expect(b.vars).toEqual(["99"]);
    expect(drain.templateCount()).toBe(1);
  });

  it("creates a separate cluster for a different token-count shape", () => {
    const drain = new Drain();
    drain.matchOrAdd("user 42 logged in");
    drain.matchOrAdd("connection lost");
    expect(drain.templateCount()).toBe(2);
  });

  it("emits stable, sequential cluster ids", () => {
    const drain = new Drain();
    expect(drain.matchOrAdd("a x b").templateId).toBe(1);
    expect(drain.matchOrAdd("c y d").templateId).toBe(2);
    expect(drain.matchOrAdd("a z b").templateId).toBe(1);
  });
});

describe("Drain.matchTemplate", () => {
  it("returns undefined for a never-seen line", () => {
    const drain = new Drain();
    expect(drain.matchTemplate("nothing here")).toBeUndefined();
  });

  it("does not mutate state", () => {
    const drain = new Drain();
    drain.matchOrAdd("user 42 logged in");
    const before = drain.templateCount();
    drain.matchTemplate("user 99 logged in");
    drain.matchTemplate("brand new line never seen");
    expect(drain.templateCount()).toBe(before);
  });
});

describe("Drain.reconstruct", () => {
  it("produces a single-space-joined line that round-trips simple templates", () => {
    const drain = new Drain();
    drain.matchOrAdd("user 42 logged in");
    const r = drain.matchOrAdd("user 99 logged in");
    const cluster = [...drain.templates()][0];
    expect(cluster).toBeDefined();
    const tokens = (cluster?.template ?? "").split(" ");
    expect(Drain.reconstruct(tokens, r.vars)).toBe("user 99 logged in");
  });

  it("normalizes runs of whitespace to single spaces (the documented contract)", () => {
    const drain = new Drain();
    drain.matchOrAdd("user 42 logged in");
    const r = drain.matchOrAdd("user   99   logged   in");
    const cluster = [...drain.templates()][0];
    expect(cluster).toBeDefined();
    const tokens = (cluster?.template ?? "").split(" ");
    expect(Drain.reconstruct(tokens, r.vars)).toBe("user 99 logged in");
  });
});

describe("DRAIN_DEFAULT_CONFIG", () => {
  it("matches the published reference defaults", () => {
    expect(DRAIN_DEFAULT_CONFIG).toEqual({
      depth: 4,
      simTh: 0.4,
      maxChildren: 100,
      parametrizeNumericTokens: true,
    });
  });
});
