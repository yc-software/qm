import { defineConfig, mergeConfig } from "vite";
import config from "../../vite.config.ts";

export default mergeConfig(
  config,
  defineConfig({
    base: "/",
    cacheDir: "node_modules/.vite-board-demo",
    optimizeDeps: { entries: ["test/support/board-demo.html"] },
    server: { host: "127.0.0.1", port: 5189, strictPort: true, open: "/board/request" },
    plugins: [
      {
        name: "qm-board-fixture-routes",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            if (path === "/" || /^\/board(?:\/[^/]+)?\/?$/.test(path)) req.url = "/test/support/board-demo.html";
            next();
          });
        },
      },
    ],
  }),
);
