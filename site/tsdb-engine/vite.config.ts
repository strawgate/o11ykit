import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const learnTopbar = readFileSync(resolve(__dirname, "learn/_topbar.html"), "utf8");

export default defineConfig({
  base: process.env.BASE_PATH ?? "/o11ykit/tsdb-engine/",
  plugins: [
    {
      name: "o11ykit-learn-topbar",
      transformIndexHtml(html) {
        return html.replaceAll("<!-- @include learn-topbar -->", learnTopbar);
      },
    },
  ],
  root: resolve(__dirname),
  resolve: {
    alias: {
      o11ytsdb: resolve(__dirname, "../../packages/o11ytsdb/src/index.ts"),
      stardb: resolve(__dirname, "../../packages/stardb/src/index.ts"),
    },
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "learn/index": resolve(__dirname, "learn/index.html"),
        "learn/alp": resolve(__dirname, "learn/alp/index.html"),
        "learn/chunk-stats": resolve(__dirname, "learn/chunk-stats/index.html"),
        "learn/delta-of-delta": resolve(__dirname, "learn/delta-of-delta/index.html"),
        "learn/query-engine": resolve(__dirname, "learn/query-engine/index.html"),
        "learn/string-interning": resolve(__dirname, "learn/string-interning/index.html"),
        "learn/xor-delta": resolve(__dirname, "learn/xor-delta/index.html"),
      },
    },
  },
});
