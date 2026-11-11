import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { ScopeId } from "../types.ts";
import type { ModelRoutes } from "./model-route.ts";
import { defaultModelForProvider, resolveModel } from "./pi-models.ts";
import { modelGatewayRequest, type ModelProvider } from "./provider-endpoints.ts";

export interface MovedDefault {
  setting: string;
  from: string;
  to: string;
}

const PURPOSES = ["fallback", "cron", "subagent", "appEdit"] as const;

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
    ...PURPOSES.map((purpose) => config.getPurposeRuntimeDurable(purpose)),
  ]);
  const baseId = base?.modelId ?? routes.baseModelId();
  const ids = [...new Set([baseId, ...purposes.flatMap((selection) => (selection ? [selection.modelId] : []))])];
  const gatewayIds = new Set(
    (
      await Promise.all(
        ids.map(async (id) => {
          const model = resolveModel(routes.servedId(id));
          return model && modelGatewayRequest(await routes.companyGateway(model), model) ? [id] : [];
        }),
      )
    ).flat(),
  );
  const onGateway = (id: string) => gatewayIds.has(id);
  const moved: MovedDefault[] = [];
  if (onGateway(baseId)) {
    await config.setRuntimeSelection(org, {
      modelId: to,
      ...(base?.effortLevel ? { effortLevel: base.effortLevel } : {}),
    });
    moved.push({ setting: "base-model", from: baseId, to });
  }
  for (const [i, purpose] of PURPOSES.entries()) {
    const selection = purposes[i];
    if (!selection || !onGateway(selection.modelId)) continue;
    await config.setPurposeRuntime(purpose, {
      modelId: to,
      ...(selection.effortLevel ? { effortLevel: selection.effortLevel } : {}),
    });
    moved.push({ setting: `${purpose}-runtime`, from: selection.modelId, to });
  }
  return moved;
}
