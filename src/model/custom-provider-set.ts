import type { createBasetenCatalog } from "./baseten.ts";
import { setCustomProviders } from "./custom-providers.ts";
import type { CustomProviderKeyStatus, CustomProviderStore } from "./model-credential-store.ts";

export function createCustomProviderSet(
  store: Pick<CustomProviderStore, "enabled" | "enabledWithKeys">,
  builtIn?: ReturnType<typeof createBasetenCatalog>,
) {
  return {
    async refresh(): Promise<void> {
      const enabled = await store.enabled();
      setCustomProviders([...enabled, ...((await builtIn?.providers(enabled)) ?? [])]);
    },
    async keys(): Promise<Record<string, string>> {
      const { enabled, keys } = await store.enabledWithKeys();
      return { ...builtIn?.keys(enabled), ...keys };
    },
    async statuses(): Promise<CustomProviderKeyStatus[]> {
      const { enabled, keys } = await store.enabledWithKeys();
      const builtInKeys = builtIn?.keys(enabled) ?? {};
      return [
        ...enabled.map((p): CustomProviderKeyStatus => ({
          provider: p.id,
          configured: Boolean(keys[p.id]),
          source: keys[p.id] ? "admin" : "absent",
        })),
        ...((await builtIn?.providers(enabled)) ?? []).map((p): CustomProviderKeyStatus => ({
          provider: p.id,
          configured: Boolean(builtInKeys[p.id]),
          source: "environment",
        })),
      ];
    },
  };
}
