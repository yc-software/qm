import type { DiscordCoreClient } from "../api/discord-core-client.ts";
import { createSurfaceRuntimeReconciler } from "../surfaces/surface-runtime.ts";
import { loadDiscordRuntimeConfig, type DiscordInstallationStore } from "../surfaces/discord-installation.ts";
import { createDiscordPlugin } from "./index.ts";

interface DiscordSurfaceDeps {
  installation: DiscordInstallationStore;
  core: DiscordCoreClient;
  startPaused: boolean;
  drainTimeoutMs: number;
  webUiPublicUrl?: string;
  onError: (error: unknown) => void;
}

export function buildDiscordSurface(deps: DiscordSurfaceDeps) {
  return createSurfaceRuntimeReconciler({
    startPaused: deps.startPaused,
    load: () => loadDiscordRuntimeConfig(deps.installation),
    startPlugin: async (desired) => {
      const plugin = createDiscordPlugin(desired, deps.core, {
        drainTimeoutMs: deps.drainTimeoutMs,
        webUiPublicUrl: deps.webUiPublicUrl,
      });
      await plugin.start();
      return plugin;
    },
    onError: deps.onError,
  });
}
