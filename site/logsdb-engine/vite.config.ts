import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/o11ykit/logsdb-engine/",
  root: resolve(__dirname),
  resolve: {
    alias: {
      o11ylogsdb: resolve(__dirname, "../../packages/o11ylogsdb/src/index.ts"),
      stardb: resolve(__dirname, "../../packages/stardb/src/index.ts"),
      "node:zlib": resolve(__dirname, "js/zlib-stub.js"),
    },
  },
  server: {
    fs: { allow: [resolve(__dirname, "../..")] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
});
