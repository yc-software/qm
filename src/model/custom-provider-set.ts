import { errMessage } from "../util/errors.ts";
import type { createBasetenCatalog } from "./baseten.ts";
import { setCustomProviders } from "./custom-providers.ts";
import type { CustomProviderKeyStatus, CustomProviderStore } from "./model-credential-store.ts";

export function createCustomProviderSet(
  store: Pick<CustomProviderStore, "enabled" | "resolveKey">,
  builtIn?: ReturnType<typeof createBasetenCatalog>,
) {
  const adminKeys = async (enabled: Awaited<ReturnType<typeof store.enabled>>) =>
    Object.fromEntries(
      (
        await Promise.all(
          enabled.map(async (p) => {
            try {
              return [p.id, await store.resolveKey(p.id)] as const;
            } catch (e) {
              console.error(`[model] custom provider ${p.id}: key unreadable: ${errMessage(e)}`);
              return [p.id, null] as const;
            }
          }),
        )
      ).filter(([, key]) => key),
    );
  return {
    async refresh(): Promise<void> {
      const enabled = await store.enabled();
      setCustomProviders([...enabled, ...((await builtIn?.providers(enabled)) ?? [])]);
    },
    async keys() {
      const enabled = await store.enabled();
      return { ...builtIn?.keys(enabled), ...(await adminKeys(enabled)) };
    },
    async statuses(): Promise<CustomProviderKeyStatus[]> {
      const enabled = await store.enabled();
      const [keys, builtInProviders] = await Promise.all([adminKeys(enabled), builtIn?.providers(enabled) ?? []]);
      const builtInKeys = builtIn?.keys(enabled) ?? {};
      return [
        ...enabled.map((p): CustomProviderKeyStatus => ({
          provider: p.id,
          configured: Boolean(keys[p.id]),
          source: keys[p.id] ? "admin" : "absent",
        })),
        ...builtInProviders.map((p): CustomProviderKeyStatus => ({
          provider: p.id,
          configured: Boolean(builtInKeys[p.id]),
          source: "environment",
        })),
      ];
    },
  };
}
