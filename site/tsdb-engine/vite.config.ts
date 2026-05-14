import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const BASE_PATH = process.env.BASE_PATH ?? "/o11ykit/tsdb-engine/";
// Derive site root by stripping the last path segment ("tsdb-engine/")
const SITE_ROOT = BASE_PATH.replace(/[^/]+\/$/, "") || "/";
let cachedTopbarTemplate = readFileSync(resolve(__dirname, "learn/_topbar.html"), "utf8");

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    {
      name: "o11ykit-learn-topbar",
      configureServer(server) {
        const topbarPath = resolve(__dirname, "learn/_topbar.html");
        server.watcher.add(topbarPath);
        server.watcher.on("change", (file) => {
          if (file === topbarPath) {
            cachedTopbarTemplate = readFileSync(topbarPath, "utf8");
            server.moduleGraph.invalidateAll();
            server.hot.send({ type: "full-reload" });
          }
        });
      },
      transformIndexHtml(html) {
        const learnTopbar = cachedTopbarTemplate.replaceAll("/o11ykit/", SITE_ROOT);
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
