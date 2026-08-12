import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { defaultModelForHarness, isHarnessId, modelSupportedByHarness, type HarnessId } from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { Harness, HarnessTurnInput } from "./harness.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { ScopeModelPolicy } from "../model/scope-model-policy.ts";

export interface RuntimeChoice {
  harnessId: HarnessId;
  modelId: string;
}

export function resolveRuntimeChoice(
  config: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel">,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  modelPolicy?: ScopeModelPolicy,
): RuntimeChoice {
  const approved = config.getApprovedHarnesses() ?? [fallback.harnessId];
  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  const configuredOrg =
    orgStored && isHarnessId(orgStored.harnessId)
      ? { harnessId: orgStored.harnessId, modelId: orgStored.modelId }
      : { harnessId: fallback.harnessId, modelId: orgLegacy ?? fallback.modelId };
  const firstApproved = approved.find(isHarnessId) ?? fallback.harnessId;
  const safeFallback =
    approved.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) };
  const org =
    approved.includes(configuredOrg.harnessId) &&
    modelSupportedByHarness(configuredOrg.modelId, configuredOrg.harnessId)
      ? configuredOrg
      : safeFallback;
  const scopedStored = scope === orgScopeId ? null : config.getRuntimeSelection(scope);
  const scopedLegacy = scope === orgScopeId ? null : config.getBaseModel(scope);
  let inherited = org;
  if (scopedStored && isHarnessId(scopedStored.harnessId)) {
    inherited = { harnessId: scopedStored.harnessId, modelId: scopedStored.modelId };
  } else if (scopedLegacy) {
    inherited = { harnessId: fallback.harnessId, modelId: scopedLegacy };
  }
  let choice =
    requested?.harnessId || requested?.modelId
      ? { harnessId: requested.harnessId ?? inherited.harnessId, modelId: requested.modelId ?? inherited.modelId }
      : inherited;
  if (modelPolicy) {
    const policy = modelPolicy.resolve(scope);
    if (requested?.modelId && !policy.models.includes(requested.modelId))
      throw new NonRetryableTurnError(`model ${requested.modelId} is not enabled for ${scope}`);
    const modelId = requested?.modelId ?? policy.defaultModel;
    let harnessId = requested?.harnessId ?? inherited.harnessId;
    if (!requested?.harnessId && !requested?.modelId && !modelSupportedByHarness(modelId, harnessId))
      harnessId =
        approved.find((id): id is HarnessId => isHarnessId(id) && modelSupportedByHarness(modelId, id)) ?? harnessId;
    choice = { harnessId, modelId };
  }
  if (!approved.includes(choice.harnessId) || !modelSupportedByHarness(choice.modelId, choice.harnessId)) {
    if (modelPolicy || requested?.harnessId || requested?.modelId)
      throw new NonRetryableTurnError(`runtime ${choice.harnessId}/${choice.modelId} is not approved`);
    return org;
  }
  return choice;
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  modelPolicy?: ScopeModelPolicy,
): Promise<RuntimeChoice> {
  const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
  const [orgStored, scopedStored, orgLegacy, scopedLegacy] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    config.getBaseModelOwnDurable(orgScopeId),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
  ]);
  const view: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel"> = {
    getApprovedHarnesses: () => approved,
    getRuntimeSelection: (id: ScopeId) => {
      if (id === orgScopeId) return orgStored;
      return id === scope ? scopedStored : null;
    },
    getBaseModel: (id: ScopeId) => {
      if (id === orgScopeId) return orgLegacy;
      return id === scope ? scopedLegacy : null;
    },
  };
  return resolveRuntimeChoice(view, orgScopeId, scope, fallback, requested, modelPolicy);
}

export function createHarnessRouter(
  adapters: ReadonlyMap<HarnessId, Harness>,
  utility: Harness,
  resolve: (input: HarnessTurnInput) => RuntimeChoice | Promise<RuntimeChoice>,
): Harness {
  const lastHarness = new Map<string, HarnessId>();
  return {
    profile: utility.profile,
    models: utility.models,
    tools: utility.tools,
    turns: {
      async runTurn(input) {
        const choice = await resolve(input);
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const prior = lastHarness.get(input.session.id);
        if (prior && prior !== choice.harnessId) {
          await adapters.get(prior)?.turns.resetSession?.(input.session.id);
          await adapter.turns.resetSession?.(input.session.id);
        }
        lastHarness.set(input.session.id, choice.harnessId);
        return adapter.turns.runTurn({ ...input, harness: choice.harnessId, model: choice.modelId });
      },
      async resetSession(sessionId) {
        lastHarness.delete(sessionId);
        await Promise.all([...adapters.values()].map((adapter) => adapter.turns.resetSession?.(sessionId)));
      },
      async close() {
        await Promise.all([...new Set(adapters.values())].map((adapter) => adapter.turns.close?.()));
      },
    },
  };
}
