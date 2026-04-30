import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/o11ykit/charts/",
  root: resolve(__dirname),
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
