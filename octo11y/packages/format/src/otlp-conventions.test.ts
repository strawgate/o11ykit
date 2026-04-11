import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ATTR_RUN_ID,
  ATTR_KIND,
  ATTR_SOURCE_FORMAT,
  ATTR_SCENARIO,
  ATTR_SERIES,
  ATTR_METRIC_DIRECTION,
  ATTR_METRIC_ROLE,
  ATTR_REF,
  ATTR_COMMIT,
  ATTR_WORKFLOW,
  ATTR_JOB,
  ATTR_SERVICE_NAME,
  MONITOR_METRIC_PREFIX,
  DEFAULT_DATA_BRANCH,
  RESERVED_DATAPOINT_ATTRIBUTES,
  VALID_RUN_KINDS,
  VALID_DIRECTIONS,
  VALID_METRIC_ROLES,
  VALID_SOURCE_FORMATS,
} from "./otlp-conventions.js";

describe("OTLP conventions constants", () => {
  it("defines all required resource attributes", () => {
    assert.equal(ATTR_RUN_ID, "benchkit.run_id");
    assert.equal(ATTR_KIND, "benchkit.kind");
    assert.equal(ATTR_SOURCE_FORMAT, "benchkit.source_format");
  });

  it("defines all required datapoint attributes", () => {
    assert.equal(ATTR_SCENARIO, "benchkit.scenario");
    assert.equal(ATTR_SERIES, "benchkit.series");
    assert.equal(ATTR_METRIC_DIRECTION, "benchkit.metric.direction");
    assert.equal(ATTR_METRIC_ROLE, "benchkit.metric.role");
  });

  it("defines recommended attributes", () => {
    assert.equal(ATTR_REF, "benchkit.ref");
    assert.equal(ATTR_COMMIT, "benchkit.commit");
    assert.equal(ATTR_WORKFLOW, "benchkit.workflow");
    assert.equal(ATTR_JOB, "benchkit.job");
    assert.equal(ATTR_SERVICE_NAME, "service.name");
  });

  it("uses consistent benchkit. prefix", () => {
    const benchkitAttrs = [
      ATTR_RUN_ID, ATTR_KIND, ATTR_SOURCE_FORMAT, ATTR_REF, ATTR_COMMIT,
      ATTR_WORKFLOW, ATTR_JOB, ATTR_SCENARIO, ATTR_SERIES,
      ATTR_METRIC_DIRECTION, ATTR_METRIC_ROLE,
    ];
    for (const attr of benchkitAttrs) {
      assert.ok(
        attr.startsWith("benchkit."),
        `Expected '${attr}' to start with 'benchkit.'`,
      );
    }
  });

  it("has valid run kinds", () => {
    assert.deepEqual([...VALID_RUN_KINDS], ["code", "workflow", "hybrid"]);
  });

  it("has valid directions", () => {
    assert.deepEqual(
      [...VALID_DIRECTIONS],
      ["bigger_is_better", "smaller_is_better"],
    );
  });

  it("has valid metric roles", () => {
    assert.deepEqual([...VALID_METRIC_ROLES], ["outcome", "diagnostic"]);
  });

  it("has valid source formats", () => {
    assert.deepEqual(
      [...VALID_SOURCE_FORMATS],
      ["go", "otlp", "rust", "hyperfine", "pytest-benchmark", "benchmark-action"],
    );
  });

  it("defines the monitor metric prefix", () => {
    assert.equal(MONITOR_METRIC_PREFIX, "_monitor.");
  });

  it("defines the default data branch name", () => {
    assert.equal(DEFAULT_DATA_BRANCH, "bench-data");
  });

  it("marks scenario, series, direction, role as reserved datapoint attributes", () => {
    assert.ok(RESERVED_DATAPOINT_ATTRIBUTES.has(ATTR_SCENARIO));
    assert.ok(RESERVED_DATAPOINT_ATTRIBUTES.has(ATTR_SERIES));
    assert.ok(RESERVED_DATAPOINT_ATTRIBUTES.has(ATTR_METRIC_DIRECTION));
    assert.ok(RESERVED_DATAPOINT_ATTRIBUTES.has(ATTR_METRIC_ROLE));
    assert.equal(RESERVED_DATAPOINT_ATTRIBUTES.size, 4);
  });
});
