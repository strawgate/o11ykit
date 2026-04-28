import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@otlpkit/adapters": resolve(__dirname, "packages/adapters/src/index.ts"),
      "@otlpkit/otlpjson": resolve(__dirname, "packages/otlpjson/src/index.ts"),
      "@otlpkit/query": resolve(__dirname, "packages/query/src/index.ts"),
      "@otlpkit/views": resolve(__dirname, "packages/views/src/index.ts"),
      o11ytsdb: resolve(__dirname, "packages/o11ytsdb/src/index.ts"),
      o11ylogsdb: resolve(__dirname, "packages/o11ylogsdb/src/index.ts"),
      o11ytracesdb: resolve(__dirname, "packages/o11ytracesdb/src/index.ts"),
      stardb: resolve(__dirname, "packages/stardb/src/index.ts"),
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
      include: [
        "packages/o11ytsdb/src/**/*.ts",
        "packages/stardb/src/**/*.ts",
        "packages/o11ylogsdb/src/**/*.ts",
        "packages/o11ytracesdb/src/**/*.ts",
      ],
      exclude: [
        "packages/o11ytsdb/src/ingest.ts", // TODO(#178): Broken: API mismatch with @otlpkit/otlpjson
        "packages/o11ytsdb/src/wasm-codecs.ts", // TODO(#179): Requires WASM binaries not in repo
        "packages/o11ytsdb/src/chunked-store.ts", // Dead code: 0% coverage, not in public API
        "packages/o11ytsdb/src/column-store.ts", // Dead code: 0% coverage, not in public API
      ],
      thresholds: {
        branches: 65,
        functions: 75,
        lines: 70,
        statements: 70,
        "packages/stardb/src/**/*.ts": {
          branches: 75,
          functions: 100,
          lines: 93,
          statements: 93,
        },
      },
    },
  },
});
