import type { CustomProviderStore } from "./custom-provider-store.ts";
import { modelSupportedByHarness } from "./pi-models.ts";

export async function readyCustomProviderIds(
  store: CustomProviderStore | undefined,
  harnessId: string,
): Promise<Set<string>> {
  const ready = new Set<string>();
  if (!store) return ready;
  const statuses = await store.statuses();
  for (const provider of statuses) {
    if (provider.disabled || !provider.hasKey) continue;
    if (!provider.models.some((model) => modelSupportedByHarness(model.id, harnessId))) continue;
    try {
      if (await store.resolveKey(provider.id)) ready.add(provider.id);
    } catch {
      continue;
    }
  }
  return ready;
}

export async function customProviderConfiguredForHarness(
  store: CustomProviderStore | undefined,
  harnessId: string,
): Promise<boolean> {
  return (await readyCustomProviderIds(store, harnessId)).size > 0;
}
