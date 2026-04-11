import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { rawUrl, type DataSource } from "./fetch.js";
import { DEFAULT_DATA_BRANCH } from "@benchkit/format";

describe("fetch", () => {
  it("constructs correct raw URLs", () => {
    const ds: DataSource = { owner: "strawgate", repo: "octo11y", branch: "bench-data" };
    const url = rawUrl(ds, "data/index.json");
    assert.equal(
      url,
      "https://raw.githubusercontent.com/strawgate/octo11y/bench-data/data/index.json",
    );
  });

  it("defaults to bench-data branch", () => {
    const ds: DataSource = { owner: "foo", repo: "bar" };
    const url = rawUrl(ds, "data/index.json");
    assert.equal(
      url,
      `https://raw.githubusercontent.com/foo/bar/${DEFAULT_DATA_BRANCH}/data/index.json`,
    );
  });

  it("baseUrl overrides GitHub raw URL construction", () => {
    const ds: DataSource = { baseUrl: "https://my-server.example.com/data" };
    const url = rawUrl(ds, "data/index.json");
    assert.equal(url, "https://my-server.example.com/data/data/index.json");
  });

  it("baseUrl ignores owner/repo/branch when set", () => {
    const ds: DataSource = {
      owner: "strawgate",
      repo: "octo11y",
      branch: "main",
      baseUrl: "https://custom.host/files",
    };
    const url = rawUrl(ds, "data/series/ns_per_op.json");
    assert.equal(url, "https://custom.host/files/data/series/ns_per_op.json");
  });

  it("baseUrl with trailing slashes is normalized", () => {
    const ds: DataSource = { baseUrl: "https://my-server.example.com/data///" };
    const url = rawUrl(ds, "data/index.json");
    assert.equal(url, "https://my-server.example.com/data/data/index.json");
  });

  it("throws when neither baseUrl nor owner+repo provided", () => {
    const ds: DataSource = {};
    assert.throws(
      () => rawUrl(ds, "data/index.json"),
      { message: "DataSource must have either baseUrl or owner+repo" },
    );
  });

  it("throws when only owner is provided without repo", () => {
    const ds: DataSource = { owner: "foo" };
    assert.throws(
      () => rawUrl(ds, "data/index.json"),
      { message: "DataSource must have either baseUrl or owner+repo" },
    );
  });

  it("constructs correct URL for prs index", () => {
    const ds: DataSource = { owner: "strawgate", repo: "octo11y", branch: "bench-data" };
    const url = rawUrl(ds, "data/index/prs.json");
    assert.equal(
      url,
      "https://raw.githubusercontent.com/strawgate/octo11y/bench-data/data/index/prs.json",
    );
  });

  it("constructs correct URL for refs index", () => {
    const ds: DataSource = { owner: "strawgate", repo: "octo11y", branch: "bench-data" };
    const url = rawUrl(ds, "data/index/refs.json");
    assert.equal(
      url,
      "https://raw.githubusercontent.com/strawgate/octo11y/bench-data/data/index/refs.json",
    );
  });

  it("constructs correct URL for metrics index", () => {
    const ds: DataSource = { owner: "strawgate", repo: "octo11y", branch: "bench-data" };
    const url = rawUrl(ds, "data/index/metrics.json");
    assert.equal(
      url,
      "https://raw.githubusercontent.com/strawgate/octo11y/bench-data/data/index/metrics.json",
    );
  });

  it("constructs correct URL for run detail view", () => {
    const ds: DataSource = { owner: "strawgate", repo: "octo11y", branch: "bench-data" };
    const url = rawUrl(ds, "data/views/runs/123456789-1/detail.json");
    assert.equal(
      url,
      "https://raw.githubusercontent.com/strawgate/octo11y/bench-data/data/views/runs/123456789-1/detail.json",
    );
  });

  it("constructs correct URL for prs index with baseUrl", () => {
    const ds: DataSource = { baseUrl: "https://my-server.example.com/data" };
    const url = rawUrl(ds, "data/index/prs.json");
    assert.equal(url, "https://my-server.example.com/data/data/index/prs.json");
  });

  it("constructs correct URL for run detail view with baseUrl", () => {
    const ds: DataSource = { baseUrl: "https://my-server.example.com/data" };
    const url = rawUrl(ds, "data/views/runs/abc-1/detail.json");
    assert.equal(url, "https://my-server.example.com/data/data/views/runs/abc-1/detail.json");
  });
});
