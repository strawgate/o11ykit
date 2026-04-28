import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/o11ykit/tracesdb-engine/",
  root: resolve(__dirname),
  resolve: {
    alias: {
      o11ytracesdb: resolve(__dirname, "../../packages/o11ytracesdb/src/index.ts"),
      stardb: resolve(__dirname, "../../packages/stardb/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "learn/index": resolve(__dirname, "learn/index.html"),
        "learn/dictionary-encoding": resolve(__dirname, "learn/dictionary-encoding/index.html"),
        "learn/nested-sets": resolve(__dirname, "learn/nested-sets/index.html"),
        "learn/bloom-filters": resolve(__dirname, "learn/bloom-filters/index.html"),
      },
    },
  },
});
