import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { ScopeId } from "../types.ts";
import { gatewayUpstreamModelId } from "./gateway-models.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { ModelRoutes } from "./model-route.ts";
import { defaultModelForProvider, resolveModel } from "./pi-models.ts";
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
  const target = (id: string) => {
    const native = gatewayUpstreamModelId(id) ?? id;
    return resolveModel(native)?.provider === provider ? native : defaultModelForProvider(provider);
  };
  const destination = async (id: string) =>
    (await routes.route(id).catch(reportFailureAs(`own provider defaults: route ${id}`, undefined)))?.billing ===
    "model_gateway"
      ? target(id)
      : undefined;
  const moved: MovedDefault[] = [];
  const base = await config.getRuntimeSelectionDurable(org);
  const baseId = base?.modelId ?? routes.baseModelId();
  const baseTo = await destination(baseId);
  if (baseTo) {
    await config.setRuntimeSelection(org, {
      modelId: baseTo,
      ...(base?.effortLevel ? { effortLevel: base.effortLevel } : {}),
    });
    moved.push({ setting: "base-model", from: baseId, to: baseTo });
  }
  for (const purpose of PURPOSES) {
    const selection = await config.getPurposeRuntimeDurable(purpose);
    const to = selection && (await destination(selection.modelId));
    if (!selection || !to) continue;
    await config.setPurposeRuntime(purpose, {
      modelId: to,
      ...(selection.effortLevel ? { effortLevel: selection.effortLevel } : {}),
    });
    moved.push({ setting: `${purpose}-runtime`, from: selection.modelId, to });
  }
  return moved;
}
