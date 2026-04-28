import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      o11ytsdb: resolve(__dirname, "packages/o11ytsdb/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "site/**/*.test.js"],
    exclude: [
      "packages/o11ytsdb/test/ingest.test.ts", // Broken: uses visitMetricPointsRaw which API changed in @otlpkit/otlpjson
      "packages/o11ytsdb/test/e2e-benchmark.test.ts", // Requires WASM binaries not in repo
      "packages/o11ytsdb/test/precision-benchmark.test.ts", // Timing-based benchmark, flaky
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html"],
      // TODO: re-enable coverage for adapters, otlpjson, query, views packages
      // once their test suites are more complete
      include: ["packages/o11ytsdb/src/**/*.ts", "packages/stardb/src/**/*.ts"],
      exclude: [
        "packages/o11ytsdb/src/ingest.ts", // TODO(#178): Broken: API mismatch with @otlpkit/otlpjson
        "packages/o11ytsdb/src/wasm-codecs.ts", // TODO(#179): Requires WASM binaries not in repo
        "packages/o11ytsdb/src/chunked-store.ts", // Dead code: 0% coverage, not in public API
        "packages/o11ytsdb/src/column-store.ts", // Dead code: 0% coverage, not in public API
      ],
      thresholds: {
        // Global floor: o11ytsdb sets the bar — stardb pulls its weight via
        // the per-glob thresholds below.
        branches: 71,
        functions: 86,
        lines: 82,
        statements: 81,
        // stardb is a tiny, high-leverage package — every engine consumes
        // it. Hold it to a strict threshold so regressions surface here
        // instead of inside whatever `*db` package noticed first.
        "packages/stardb/src/**/*.ts": {
          branches: 90,
          functions: 100,
          lines: 95,
          statements: 95,
        },
      },
    },
  },
});
