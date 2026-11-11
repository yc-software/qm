import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { ScopeId } from "../types.ts";
import type { ModelRoutes } from "./model-route.ts";
import { defaultModelForProvider } from "./pi-models.ts";
import type { ModelProvider } from "./provider-endpoints.ts";

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
  const onGateway = (id: string) => routes.onCompanyGateway(id);
  const [base, ...purposes] = await Promise.all([
    config.getRuntimeSelectionDurable(org),
    ...PURPOSES.map((purpose) => config.getPurposeRuntimeDurable(purpose)),
  ]);
  const moved: MovedDefault[] = [];
  const baseId = base?.modelId ?? routes.baseModelId();
  if (await onGateway(baseId)) {
    await config.setRuntimeSelection(org, {
      modelId: to,
      ...(base?.effortLevel ? { effortLevel: base.effortLevel } : {}),
    });
    moved.push({ setting: "base-model", from: baseId, to });
  }
  for (const [i, purpose] of PURPOSES.entries()) {
    const selection = purposes[i];
    if (!selection || !(await onGateway(selection.modelId))) continue;
    await config.setPurposeRuntime(purpose, {
      modelId: to,
      ...(selection.effortLevel ? { effortLevel: selection.effortLevel } : {}),
    });
    moved.push({ setting: `${purpose}-runtime`, from: selection.modelId, to });
  }
  return moved;
}
