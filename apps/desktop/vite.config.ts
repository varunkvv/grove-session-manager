import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.join(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(import.meta.dirname, "out/renderer"),
    emptyOutDir: true,
    // no inline script, so the production CSP can stay at script-src 'self'
    modulePreload: { polyfill: false },
    sourcemap: true,
  },
  server: { port: 5183, strictPort: true },
});
