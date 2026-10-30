import type { ScopedConfigStore, RuntimePurpose } from "../resolution/config-store.ts";
import {
  defaultModelForHarness,
  fastModeModelIds,
  harnessSupportsFastMode,
  isHarnessId,
  modelSupportedByHarness,
  resolveModel,
  thinkingLevelsForHarness,
  modelUnavailableReason,
} from "./pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { RuntimeChoice } from "../agent/harness.ts";
import { NON_INTERACTIVE_THINKING_LEVEL, NON_INTERACTIVE_FAST_MODE } from "../core/turn-options.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";

function normalizeRuntimeChoice(choice: RuntimeChoice): RuntimeChoice {
  if (
    (choice.effortLevel === "adaptive" || choice.effortLevel === "default") &&
    !thinkingLevelsForHarness(choice.harnessId, choice.modelId).includes(choice.effortLevel)
  )
    throw new NonRetryableTurnError(
      `${choice.effortLevel} reasoning is not supported by ${choice.harnessId}/${choice.modelId}`,
    );
  return {
    harnessId: choice.harnessId,
    modelId: choice.modelId,
    ...(choice.effortLevel && thinkingLevelsForHarness(choice.harnessId, choice.modelId).includes(choice.effortLevel)
      ? { effortLevel: choice.effortLevel }
      : {}),
    ...(typeof choice.fastMode === "boolean"
      ? {
          fastMode:
            choice.fastMode && harnessSupportsFastMode(choice.harnessId) && fastModeModelIds().includes(choice.modelId),
        }
      : {}),
  };
}

export function resolveRuntimeChoice(
  config: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel"> &
    Partial<Pick<ScopedConfigStore, "getPurposeRuntime">>,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  purpose?: RuntimePurpose,
): RuntimeChoice {
  const approved = config.getApprovedHarnesses() ?? [fallback.harnessId];
  if (approved.length === 0) throw new NonRetryableTurnError("No harnesses are approved");
  const purposeRuntime = purpose ? config.getPurposeRuntime?.(purpose) : undefined;
  if (purposeRuntime) {
    const explicit = Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value !== undefined));
    const choice = { ...purposeRuntime, ...explicit };
    if (
      !isHarnessId(choice.harnessId) ||
      !approved.includes(choice.harnessId) ||
      !modelSupportedByHarness(choice.modelId, choice.harnessId)
    )
      throw new NonRetryableTurnError(`runtime ${choice.harnessId}/${choice.modelId} is not approved`);
    const unavailable = modelUnavailableReason(choice.modelId);
    if (unavailable) throw new NonRetryableTurnError(`${choice.modelId}: ${unavailable}`);
    if (
      choice.effortLevel !== undefined &&
      !thinkingLevelsForHarness(choice.harnessId, choice.modelId).includes(choice.effortLevel)
    )
      throw new NonRetryableTurnError(
        `${choice.effortLevel} reasoning is not supported by ${choice.harnessId}/${choice.modelId}`,
      );
    if (choice.fastMode && (!harnessSupportsFastMode(choice.harnessId) || !fastModeModelIds().includes(choice.modelId)))
      throw new NonRetryableTurnError(`fast mode is not supported by ${choice.harnessId}/${choice.modelId}`);
    return { ...choice, harnessId: choice.harnessId };
  }
  if (purpose === "cron")
    requested = { effortLevel: NON_INTERACTIVE_THINKING_LEVEL, fastMode: NON_INTERACTIVE_FAST_MODE, ...requested };

  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  const configuredOrg: RuntimeChoice =
    orgStored && isHarnessId(orgStored.harnessId)
      ? {
          harnessId: orgStored.harnessId,
          modelId: orgStored.modelId,
          ...(orgStored.effortLevel ? { effortLevel: orgStored.effortLevel } : {}),
          ...(typeof orgStored.fastMode === "boolean" ? { fastMode: orgStored.fastMode } : {}),
        }
      : { harnessId: fallback.harnessId, modelId: orgLegacy ?? fallback.modelId };
  const configuredId =
    requested?.modelId ??
    (scope !== orgScopeId ? (config.getRuntimeSelection(scope)?.modelId ?? config.getBaseModel(scope)) : null) ??
    configuredOrg.modelId;
  const unavailableReason = modelUnavailableReason(configuredId);
  if (unavailableReason) throw new NonRetryableTurnError(`${configuredId}: ${unavailableReason}`);
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
  let inherited: RuntimeChoice = org;
  if (scopedStored && isHarnessId(scopedStored.harnessId)) {
    inherited = {
      harnessId: scopedStored.harnessId,
      modelId: scopedStored.modelId,
      ...(scopedStored.effortLevel ? { effortLevel: scopedStored.effortLevel } : {}),
      ...(typeof scopedStored.fastMode === "boolean" ? { fastMode: scopedStored.fastMode } : {}),
    };
  } else if (scopedLegacy) {
    inherited = { harnessId: fallback.harnessId, modelId: scopedLegacy };
  }
  const choice = { ...inherited, ...requested };
  if (!approved.includes(choice.harnessId) || !modelSupportedByHarness(choice.modelId, choice.harnessId)) {
    if (requested?.harnessId || requested?.modelId)
      throw new NonRetryableTurnError(`runtime ${choice.harnessId}/${choice.modelId} is not approved`);
    return normalizeRuntimeChoice({ ...org, ...requested });
  }
  return normalizeRuntimeChoice(choice);
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  hydrateModelCatalog?: () => Promise<unknown>,
  purpose?: RuntimePurpose,
): Promise<RuntimeChoice> {
  const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
  const [orgStored, scopedStored, orgLegacy, scopedLegacy, purposeRuntime] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    config.getBaseModelOwnDurable(orgScopeId),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
    purpose ? config.getPurposeRuntimeDurable(purpose) : undefined,
  ]);
  if (hydrateModelCatalog) {
    const candidates = [requested?.modelId, purposeRuntime?.modelId, scopedStored?.modelId, orgStored?.modelId];
    if (candidates.some((modelId) => modelId && !resolveModel(modelId))) await hydrateModelCatalog();
  }
  const view: Pick<
    ScopedConfigStore,
    "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel" | "getPurposeRuntime"
  > = {
    getApprovedHarnesses: () => approved,
    getPurposeRuntime: () => purposeRuntime,
    getRuntimeSelection: (id: ScopeId) => {
      if (id === orgScopeId) return orgStored;
      return id === scope ? scopedStored : null;
    },
    getBaseModel: (id: ScopeId) => {
      if (id === orgScopeId) return orgLegacy;
      return id === scope ? scopedLegacy : null;
    },
  };
  return resolveRuntimeChoice(view, orgScopeId, scope, fallback, requested, purpose);
}
