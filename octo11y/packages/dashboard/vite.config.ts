import { defineConfig } from "vite";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "/octo11y/",
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
