import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const siteRoot = resolve(__dirname, "..");

const sharedSiteAssets = new Map([
  [
    "/o11ykit/styles.css",
    { file: resolve(siteRoot, "styles.css"), contentType: "text/css; charset=utf-8" },
  ],
  ["/o11ykit/logo.svg", { file: resolve(siteRoot, "logo.svg"), contentType: "image/svg+xml" }],
]);

export default defineConfig({
  base: process.env.BASE_PATH ?? "/o11ykit/charts/",
  root: resolve(__dirname),
  plugins: [
    {
      name: "serve-o11ykit-shared-assets",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const pathname = req.url?.split("?")[0] ?? "";
          const asset = sharedSiteAssets.get(pathname);
          if (!asset) {
            next();
            return;
          }

          res.setHeader("Content-Type", asset.contentType);
          res.end(await readFile(asset.file));
        });
      },
    },
  ],
  resolve: {
    alias: {
      stardb: resolve(__dirname, "js/stardb-browser.ts"),
    },
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
