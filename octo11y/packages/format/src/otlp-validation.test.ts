import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateRequiredResourceAttributes,
  validateRequiredDatapointAttributes,
  validateRunKind,
  validateDirection,
  validateMetricRole,
  validateSourceFormat,
  isValidRunKind,
  isValidDirection,
  isValidMetricRole,
  isValidSourceFormat,
  isMonitorMetric,
} from "./otlp-validation.js";

describe("validateRequiredResourceAttributes", () => {
  const validAttrs = {
    "benchkit.run_id": "12345678-1",
    "benchkit.kind": "workflow",
    "benchkit.source_format": "otlp",
  };

  it("accepts valid resource attributes", () => {
    assert.doesNotThrow(() => validateRequiredResourceAttributes(validAttrs));
  });

  it("throws when benchkit.run_id is missing", () => {
    const { "benchkit.run_id": _, ...without } = validAttrs;
    assert.throws(
      () => validateRequiredResourceAttributes(without),
      /Missing required attribute 'benchkit\.run_id'/,
    );
  });

  it("throws when benchkit.kind is missing", () => {
    const { "benchkit.kind": _, ...without } = validAttrs;
    assert.throws(
      () => validateRequiredResourceAttributes(without),
      /Missing required attribute 'benchkit\.kind'/,
    );
  });

  it("throws when benchkit.kind is invalid", () => {
    assert.throws(
      () =>
        validateRequiredResourceAttributes({
          ...validAttrs,
          "benchkit.kind": "invalid",
        }),
      /Invalid 'benchkit\.kind' value 'invalid'/,
    );
  });

  it("throws when benchkit.source_format is missing", () => {
    const { "benchkit.source_format": _, ...without } = validAttrs;
    assert.throws(
      () => validateRequiredResourceAttributes(without),
      /Missing required attribute 'benchkit\.source_format'/,
    );
  });

  it("throws when benchkit.source_format is invalid", () => {
    assert.throws(
      () =>
        validateRequiredResourceAttributes({
          ...validAttrs,
          "benchkit.source_format": "unknown",
        }),
      /Invalid 'benchkit\.source_format' value 'unknown'/,
    );
  });
});

describe("validateRequiredDatapointAttributes", () => {
  const validAttrs = {
    "benchkit.scenario": "json-ingest",
    "benchkit.series": "elastic-agent",
  };

  it("accepts valid datapoint attributes", () => {
    assert.doesNotThrow(() =>
      validateRequiredDatapointAttributes(validAttrs, "events_per_sec"),
    );
  });

  it("throws when benchkit.scenario is missing for non-monitor metric", () => {
    assert.throws(
      () => validateRequiredDatapointAttributes({}, "events_per_sec"),
      /Missing required attribute 'benchkit\.scenario'/,
    );
  });

  it("throws when benchkit.series is missing for non-monitor metric", () => {
    assert.throws(
      () =>
        validateRequiredDatapointAttributes(
          { "benchkit.scenario": "test" },
          "events_per_sec",
        ),
      /Missing required attribute 'benchkit\.series'/,
    );
  });

  it("skips scenario validation for monitor metrics but requires series", () => {
    assert.doesNotThrow(() =>
      validateRequiredDatapointAttributes(
        { "benchkit.series": "runner" },
        "_monitor.cpu_user_pct",
      ),
    );
  });

  it("throws when benchkit.series is missing for monitor metrics", () => {
    assert.throws(
      () => validateRequiredDatapointAttributes({}, "_monitor.cpu_user_pct"),
      /Missing required attribute 'benchkit\.series'/,
    );
  });
});

describe("type guards", () => {
  describe("isValidRunKind", () => {
    it("accepts valid run kinds", () => {
      assert.ok(isValidRunKind("code"));
      assert.ok(isValidRunKind("workflow"));
      assert.ok(isValidRunKind("hybrid"));
    });

    it("rejects invalid run kinds", () => {
      assert.ok(!isValidRunKind("invalid"));
      assert.ok(!isValidRunKind(""));
    });
  });

  describe("validateRunKind", () => {
    it("returns valid kind", () => {
      assert.equal(validateRunKind("code"), "code");
    });

    it("throws on undefined", () => {
      assert.throws(
        () => validateRunKind(undefined),
        /Missing required attribute 'benchkit\.kind'/,
      );
    });

    it("throws on invalid value", () => {
      assert.throws(
        () => validateRunKind("bad"),
        /Invalid 'benchkit\.kind' value 'bad'/,
      );
    });
  });

  describe("isValidDirection", () => {
    it("accepts valid directions", () => {
      assert.ok(isValidDirection("bigger_is_better"));
      assert.ok(isValidDirection("smaller_is_better"));
    });

    it("rejects invalid directions", () => {
      assert.ok(!isValidDirection("up"));
      assert.ok(!isValidDirection(""));
    });
  });

  describe("validateDirection", () => {
    it("returns valid direction", () => {
      assert.equal(validateDirection("bigger_is_better"), "bigger_is_better");
    });

    it("throws on undefined", () => {
      assert.throws(() => validateDirection(undefined), /Missing required/);
    });

    it("throws on invalid value", () => {
      assert.throws(
        () => validateDirection("upward"),
        /Invalid 'benchkit\.metric\.direction'/,
      );
    });
  });

  describe("isValidMetricRole", () => {
    it("accepts valid roles", () => {
      assert.ok(isValidMetricRole("outcome"));
      assert.ok(isValidMetricRole("diagnostic"));
    });

    it("rejects invalid roles", () => {
      assert.ok(!isValidMetricRole("primary"));
      assert.ok(!isValidMetricRole(""));
    });
  });

  describe("validateMetricRole", () => {
    it("returns valid role", () => {
      assert.equal(validateMetricRole("outcome"), "outcome");
    });

    it("throws on undefined", () => {
      assert.throws(() => validateMetricRole(undefined), /Missing required/);
    });

    it("throws on invalid value", () => {
      assert.throws(
        () => validateMetricRole("main"),
        /Invalid 'benchkit\.metric\.role'/,
      );
    });
  });

  describe("isValidSourceFormat", () => {
    it("accepts valid source formats", () => {
      assert.ok(isValidSourceFormat("go"));
      assert.ok(isValidSourceFormat("otlp"));
    });

    it("rejects invalid source formats", () => {
      assert.ok(!isValidSourceFormat("native"));
      assert.ok(!isValidSourceFormat("csv"));
      assert.ok(!isValidSourceFormat(""));
    });
  });

  describe("validateSourceFormat", () => {
    it("returns valid format", () => {
      assert.equal(validateSourceFormat("rust"), "rust");
    });

    it("throws on undefined", () => {
      assert.throws(
        () => validateSourceFormat(undefined),
        /Missing required/,
      );
    });
  });
});

describe("isMonitorMetric", () => {
  it("detects _monitor. prefix", () => {
    assert.ok(isMonitorMetric("_monitor.cpu_user_pct"));
    assert.ok(isMonitorMetric("_monitor.peak_rss_kb"));
  });

  it("rejects non-monitor metrics", () => {
    assert.ok(!isMonitorMetric("events_per_sec"));
    assert.ok(!isMonitorMetric("monitor.cpu"));
    assert.ok(!isMonitorMetric(""));
  });
});
