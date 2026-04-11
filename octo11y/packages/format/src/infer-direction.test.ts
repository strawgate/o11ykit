import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferDirection } from "./infer-direction.js";

describe("inferDirection", () => {
  it("returns bigger_is_better for throughput units", () => {
    for (const unit of ["ops/s", "op/s", "req/sec", "MB/s", "throughput", "events"]) {
      assert.equal(inferDirection(unit), "bigger_is_better", `expected bigger_is_better for "${unit}"`);
    }
  });

  it("returns smaller_is_better for latency and allocation units", () => {
    for (const unit of ["ns/op", "ms/op", "us/op", "s/op", "B/op", "allocs/op", "bytes", "ms"]) {
      assert.equal(inferDirection(unit), "smaller_is_better", `expected smaller_is_better for "${unit}"`);
    }
  });

  it("defaults to smaller_is_better for unknown units", () => {
    assert.equal(inferDirection("widgets"), "smaller_is_better");
  });

  it("is case-insensitive", () => {
    assert.equal(inferDirection("OPS/S"), "bigger_is_better");
    assert.equal(inferDirection("Mb/S"), "bigger_is_better");
  });
});
