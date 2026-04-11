import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateCollectorConfig,
  validateMetricSets,
  validateScrapeInterval,
  type CollectorConfigOptions,
} from "./otel-config.js";

function baseOpts(overrides?: Partial<CollectorConfigOptions>): CollectorConfigOptions {
  return {
    scrapeInterval: "1s",
    metricSets: ["cpu", "memory", "load"],
    otlpGrpcPort: 4317,
    otlpHttpPort: 4318,
    outputPath: "/tmp/otel-metrics.jsonl",
    runId: "12345-1",
    ref: "refs/heads/main",
    commit: "abc123",
    ...overrides,
  };
}

describe("validateMetricSets", () => {
  it("accepts valid metric set names", () => {
    assert.deepEqual(
      validateMetricSets(["cpu", "memory", "load", "process"]),
      ["cpu", "memory", "load", "process"],
    );
  });

  it("normalizes whitespace and case", () => {
    assert.deepEqual(
      validateMetricSets([" CPU ", "Memory"]),
      ["cpu", "memory"],
    );
  });

  it("filters empty strings", () => {
    assert.deepEqual(validateMetricSets(["cpu", "", "memory"]), ["cpu", "memory"]);
  });

  it("throws on unknown metric set", () => {
    assert.throws(() => validateMetricSets(["cpu", "bogus"]), /Unknown metric set 'bogus'/);
  });

  it("accepts all valid sets", () => {
    const all = ["cpu", "memory", "load", "process", "disk", "network", "filesystem", "paging"];
    assert.deepEqual(validateMetricSets(all), all);
  });
});

describe("generateCollectorConfig", () => {
  it("generates config with hostmetrics and otlp receivers", () => {
    const yaml = generateCollectorConfig(baseOpts());
    assert.match(yaml, /hostmetrics:/);
    assert.match(yaml, /collection_interval: 1s/);
    assert.match(yaml, /cpu: \{\}/);
    assert.match(yaml, /memory: \{\}/);
    assert.match(yaml, /load: \{\}/);
    assert.match(yaml, /otlp:/);
    assert.match(yaml, /endpoint: "127\.0\.0\.1:4317"/);
    assert.match(yaml, /endpoint: "127\.0\.0\.1:4318"/);
    assert.match(yaml, /receivers: \[hostmetrics, otlp\]/);
    assert.match(yaml, /exporters: \[file\]/);
  });

  it("includes resource processor with benchkit attributes", () => {
    const yaml = generateCollectorConfig(baseOpts());
    assert.match(yaml, /key: benchkit\.run_id/);
    assert.match(yaml, /value: "12345-1"/);
    assert.match(yaml, /key: benchkit\.kind/);
    assert.match(yaml, /value: "hybrid"/);
    assert.match(yaml, /key: benchkit\.source_format/);
    assert.match(yaml, /value: "otlp"/);
    assert.match(yaml, /key: benchkit\.ref/);
    assert.match(yaml, /value: "refs\/heads\/main"/);
    assert.match(yaml, /key: benchkit\.commit/);
    assert.match(yaml, /value: "abc123"/);
    assert.match(yaml, /action: upsert/);
  });

  it("disables grpc when port is 0", () => {
    const yaml = generateCollectorConfig(baseOpts({ otlpGrpcPort: 0 }));
    assert.doesNotMatch(yaml, /grpc:/);
    assert.match(yaml, /http:/);
    assert.match(yaml, /receivers: \[hostmetrics, otlp\]/);
  });

  it("disables http when port is 0", () => {
    const yaml = generateCollectorConfig(baseOpts({ otlpHttpPort: 0 }));
    assert.match(yaml, /grpc:/);
    assert.doesNotMatch(yaml, /http:/);
  });

  it("omits otlp receiver entirely when both ports are 0", () => {
    const yaml = generateCollectorConfig(baseOpts({ otlpGrpcPort: 0, otlpHttpPort: 0 }));
    assert.doesNotMatch(yaml, /otlp:/);
    assert.match(yaml, /receivers: \[hostmetrics\]/);
  });

  it("generates process scraper with mute flags", () => {
    const yaml = generateCollectorConfig(baseOpts({ metricSets: ["process"] }));
    assert.match(yaml, /process:/);
    assert.match(yaml, /mute_process_name_error: true/);
    assert.match(yaml, /mute_process_exe_error: true/);
    assert.match(yaml, /mute_process_io_error: true/);
  });

  it("omits optional resource attrs when not provided", () => {
    const yaml = generateCollectorConfig(baseOpts({ ref: undefined, commit: undefined }));
    assert.doesNotMatch(yaml, /benchkit\.ref/);
    assert.doesNotMatch(yaml, /benchkit\.commit/);
    assert.match(yaml, /benchkit\.run_id/);
  });

  it("throws when no receivers are enabled", () => {
    assert.throws(
      () => generateCollectorConfig(baseOpts({ metricSets: [], otlpGrpcPort: 0, otlpHttpPort: 0 })),
      /No receivers enabled/,
    );
  });

  it("sets the file exporter path", () => {
    const yaml = generateCollectorConfig(baseOpts({ outputPath: "/data/metrics.jsonl" }));
    assert.match(yaml, /path: "\/data\/metrics\.jsonl"/);
  });

  it("respects custom scrape interval", () => {
    const yaml = generateCollectorConfig(baseOpts({ scrapeInterval: "250ms" }));
    assert.match(yaml, /collection_interval: 250ms/);
  });

  it("escapes double quotes in resource attribute values", () => {
    const yaml = generateCollectorConfig(baseOpts({ ref: 'refs/heads/feat/"quoted"' }));
    assert.match(yaml, /value: "refs\/heads\/feat\/\\"quoted\\""/);
  });

  it("escapes backslashes in resource attribute values", () => {
    const yaml = generateCollectorConfig(baseOpts({ commit: "path\\to\\thing" }));
    assert.match(yaml, /value: "path\\\\to\\\\thing"/);
  });

  it("escapes double quotes in output path", () => {
    const yaml = generateCollectorConfig(baseOpts({ outputPath: '/tmp/"weird"/out.jsonl' }));
    assert.match(yaml, /path: "\/tmp\/\\"weird\\"\/out\.jsonl"/);
  });

  it("works with otlp-only config (no hostmetrics)", () => {
    const yaml = generateCollectorConfig(baseOpts({ metricSets: [] }));
    assert.doesNotMatch(yaml, /hostmetrics:/);
    assert.match(yaml, /otlp:/);
    assert.match(yaml, /receivers: \[otlp\]/);
  });

  it("includes all metric sets when specified", () => {
    const all = ["cpu", "memory", "load", "process", "disk", "network", "filesystem", "paging"];
    const yaml = generateCollectorConfig(baseOpts({ metricSets: all }));
    assert.match(yaml, /cpu: \{\}/);
    assert.match(yaml, /memory: \{\}/);
    assert.match(yaml, /load: \{\}/);
    assert.match(yaml, /process:/);
    assert.match(yaml, /disk: \{\}/);
    assert.match(yaml, /network: \{\}/);
    assert.match(yaml, /filesystem: \{\}/);
    assert.match(yaml, /paging: \{\}/);
  });

  it("includes processors in the pipeline", () => {
    const yaml = generateCollectorConfig(baseOpts());
    assert.match(yaml, /processors: \[resource\]/);
  });

  it("always includes benchkit.run_id, benchkit.kind, benchkit.source_format", () => {
    const yaml = generateCollectorConfig(baseOpts({ ref: undefined, commit: undefined }));
    assert.match(yaml, /benchkit\.run_id/);
    assert.match(yaml, /benchkit\.kind/);
    assert.match(yaml, /benchkit\.source_format/);
  });

  it("binds OTLP to localhost not 0.0.0.0", () => {
    const yaml = generateCollectorConfig(baseOpts());
    assert.match(yaml, /127\.0\.0\.1/);
    assert.doesNotMatch(yaml, /0\.0\.0\.0/);
  });
});

describe("validateScrapeInterval", () => {
  it("accepts valid intervals", () => {
    assert.equal(validateScrapeInterval("1s"), "1s");
    assert.equal(validateScrapeInterval("250ms"), "250ms");
    assert.equal(validateScrapeInterval("5m"), "5m");
    assert.equal(validateScrapeInterval("1h"), "1h");
  });

  it("rejects invalid intervals", () => {
    assert.throws(() => validateScrapeInterval("banana"), /Invalid scrape interval/);
    assert.throws(() => validateScrapeInterval(""), /Invalid scrape interval/);
    assert.throws(() => validateScrapeInterval("1x"), /Invalid scrape interval/);
    assert.throws(() => validateScrapeInterval("1s\nmalicious: true"), /Invalid scrape interval/);
  });
});

describe("validateMetricSets — error paths", () => {
  it("rejects unknown metric set names with helpful message", () => {
    assert.throws(
      () => validateMetricSets(["cpu", "bogus"]),
      /Unknown metric set 'bogus'/,
    );
  });

  it("error message lists valid sets", () => {
    assert.throws(
      () => validateMetricSets(["invalid"]),
      /Valid sets:/,
    );
  });

  it("trims and lowercases inputs", () => {
    assert.deepEqual(
      validateMetricSets(["  CPU  ", " Memory "]),
      ["cpu", "memory"],
    );
  });

  it("filters empty entries", () => {
    assert.deepEqual(
      validateMetricSets(["cpu", "", "  "]),
      ["cpu"],
    );
  });
});

describe("generateCollectorConfig — error paths", () => {
  it("throws when no receivers are enabled", () => {
    assert.throws(
      () => generateCollectorConfig(baseOpts({
        metricSets: [],
        otlpGrpcPort: 0,
        otlpHttpPort: 0,
      })),
      /No receivers enabled/,
    );
  });
});
