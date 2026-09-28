import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is served by the git-flower-garden service from dist/ui. During UI
// development, `npm run dev:ui` proxies API calls to a running service.
// `--mode pages` builds the static GitHub Pages demo into dist/pages instead:
// it reads a saved snapshot (scripts/pages-snapshot.ts) from demo-data/.
export default defineConfig(({ mode }) => {
  const pages = mode === "pages";
  return {
    root: "src/ui",
    base: pages ? "/git-flower-garden/" : "/",
    plugins: [react()],
    build: {
      outDir: pages ? "../../dist/pages" : "../../dist/ui",
      emptyOutDir: true,
      // No inline scripts or styles: the service's CSP allows only same-origin files.
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
    },
    server: {
      proxy: { "/api": "http://127.0.0.1:4783" },
    },
  };
});
