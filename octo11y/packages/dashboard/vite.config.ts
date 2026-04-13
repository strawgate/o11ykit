import { defineConfig } from "vite";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";

const base = process.env.BASE_PATH || "/octo11y/";

export default defineConfig({
  plugins: [preact()],
  base,
  build: {
    commonjsOptions: {
      include: [/format/, /node_modules/],
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        embed: resolve(__dirname, "embed.html"),
      },
    },
  },
});
