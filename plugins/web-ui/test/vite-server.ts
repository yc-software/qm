import { createServer, type InlineConfig } from "vite";

export function testViteServer(config: Pick<InlineConfig, "root" | "configFile" | "plugins"> = {}) {
  return createServer({
    ...config,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
}
