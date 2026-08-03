import { createServer, type InlineConfig, type ViteDevServer } from "vite";

export function createViteTestServer(config: InlineConfig = {}): Promise<ViteDevServer> {
  return createServer({
    ...config,
    appType: "custom",
    server: { ...config.server, middlewareMode: true, hmr: false, ws: false },
  });
}
