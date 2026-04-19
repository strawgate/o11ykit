import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "site/**/*.test.js"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "packages/otlpjson/src/**/*.ts",
        "packages/query/src/**/*.ts",
        "packages/views/src/**/*.ts",
        "packages/adapters/src/**/*.ts",
      ],
      exclude: [
        // Worker runtime files require browser Worker / node:worker_threads context
        // and cannot be unit-tested in the vitest environment
        "packages/o11ytsdb/src/worker.ts",
        "packages/o11ytsdb/src/worker-client.ts",
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
