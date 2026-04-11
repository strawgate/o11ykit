import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unitToMetricName } from "./parser-utils.js";

describe("unitToMetricName", () => {
  it("applies known aliases", () => {
    assert.equal(unitToMetricName("B/op"), "bytes_per_op");
    assert.equal(unitToMetricName("MB/s"), "mb_per_s");
    assert.equal(unitToMetricName("ns/iter"), "ns_per_iter");
  });

  it("replaces / with _per_ and lowercases", () => {
    assert.equal(unitToMetricName("ns/op"), "ns_per_op");
    assert.equal(unitToMetricName("allocs/op"), "allocs_per_op");
  });

  it("replaces spaces with underscores", () => {
    assert.equal(unitToMetricName("bytes per sec"), "bytes_per_sec");
  });

  it("returns plain unit names unchanged (modulo case)", () => {
    assert.equal(unitToMetricName("ms"), "ms");
    assert.equal(unitToMetricName("bytes"), "bytes");
  });
});
