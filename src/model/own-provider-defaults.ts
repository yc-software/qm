import { PURPOSE_RUNTIME_RESOURCES } from "../api/routes/admin-resources.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { ScopeId } from "../types.ts";
import type { ModelRoutes } from "./model-route.ts";
import { defaultModelForProvider, resolveModel } from "./pi-models.ts";
import type { ModelProvider } from "./provider-endpoints.ts";

export interface MovedDefault {
  setting: string;
  label: string;
  from: string;
  to: string;
}

export async function moveGatewayDefaultsToProvider(
  config: ScopedConfigStore,
  routes: ModelRoutes,
  provider: ModelProvider,
  org: ScopeId,
): Promise<MovedDefault[]> {
  const to = defaultModelForProvider(provider);
  if (!to) return [];
  const [base, ...purposes] = await Promise.all([
    config.getRuntimeSelectionDurable(org),
    ...PURPOSE_RUNTIME_RESOURCES.map(({ purpose }) => config.getPurposeRuntimeDurable(purpose)),
  ]);
  const baseId = base?.modelId ?? routes.baseModelId();
  const uniqueIds = [...new Set([baseId, ...purposes.flatMap((selection) => (selection ? [selection.modelId] : []))])];
  const onGatewayFlags = await Promise.all(
    uniqueIds.map(async (id) => {
      const model = resolveModel(routes.servedId(id));
      return !!model && !!(await routes.companyGateway(model))?.models[model.id];
    }),
  );
  const gatewayIds = new Set(uniqueIds.filter((_, i) => onGatewayFlags[i]));
  const moved: MovedDefault[] = [];
  if (gatewayIds.has(baseId)) {
    await config.setRuntimeSelection(org, {
      modelId: to,
      ...(base?.effortLevel ? { effortLevel: base.effortLevel } : {}),
    });
    moved.push({ setting: "base-model", label: "Base model", from: baseId, to });
  }
  for (const [i, { id, purpose, name }] of PURPOSE_RUNTIME_RESOURCES.entries()) {
    const selection = purposes[i];
    if (!selection || !gatewayIds.has(selection.modelId)) continue;
    await config.setPurposeRuntime(purpose, {
      modelId: to,
      ...(selection.effortLevel ? { effortLevel: selection.effortLevel } : {}),
    });
    moved.push({ setting: id, label: name, from: selection.modelId, to });
  }
  return moved;
}
