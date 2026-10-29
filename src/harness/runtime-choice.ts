import type { ScopedConfigStore, RuntimePurpose } from "../resolution/config-store.ts";
import {
  defaultModel,
  fastModeModelIds,
  modelSupported,
  resolveModel,
  safeModelMetadata,
  thinkingLevelsFor,
  modelUnavailableReason,
} from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { Harness, HarnessTurnInput, RuntimeChoice } from "./harness.ts";
import { NON_INTERACTIVE_THINKING_LEVEL, NON_INTERACTIVE_FAST_MODE } from "../core/turn-options.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { governGoal, type GoalGovernorInput } from "./goal.ts";

function normalizeRuntimeChoice(choice: RuntimeChoice): RuntimeChoice {
  if (
    (choice.effortLevel === "adaptive" || choice.effortLevel === "default") &&
    !thinkingLevelsFor(choice.modelId).includes(choice.effortLevel)
  )
    throw new NonRetryableTurnError(`${choice.effortLevel} reasoning is not supported by ${choice.modelId}`);
  return {
    modelId: choice.modelId,
    ...(choice.effortLevel && thinkingLevelsFor(choice.modelId).includes(choice.effortLevel)
      ? { effortLevel: choice.effortLevel }
      : {}),
    ...(typeof choice.fastMode === "boolean"
      ? { fastMode: choice.fastMode && fastModeModelIds().includes(choice.modelId) }
      : {}),
  };
}

function storedChoice(stored: RuntimeChoice): RuntimeChoice {
  return {
    modelId: stored.modelId,
    ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
    ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
  };
}

export function resolveRuntimeChoice(
  config: Pick<ScopedConfigStore, "getRuntimeSelection" | "getBaseModel"> &
    Partial<Pick<ScopedConfigStore, "getPurposeRuntime">>,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  purpose?: RuntimePurpose,
): RuntimeChoice {
  const purposeRuntime = purpose ? config.getPurposeRuntime?.(purpose) : undefined;
  if (purposeRuntime) {
    const explicit = Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value !== undefined));
    const choice: RuntimeChoice = { ...purposeRuntime, ...explicit };
    if (!modelSupported(choice.modelId)) throw new NonRetryableTurnError(`runtime ${choice.modelId} is not approved`);
    const unavailable = modelUnavailableReason(choice.modelId);
    if (unavailable) throw new NonRetryableTurnError(`${choice.modelId}: ${unavailable}`);
    if (choice.effortLevel !== undefined && !thinkingLevelsFor(choice.modelId).includes(choice.effortLevel))
      throw new NonRetryableTurnError(`${choice.effortLevel} reasoning is not supported by ${choice.modelId}`);
    if (choice.fastMode && !fastModeModelIds().includes(choice.modelId))
      throw new NonRetryableTurnError(`fast mode is not supported by ${choice.modelId}`);
    return choice;
  }
  if (purpose === "cron")
    requested = { effortLevel: NON_INTERACTIVE_THINKING_LEVEL, fastMode: NON_INTERACTIVE_FAST_MODE, ...requested };

  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  const configuredOrg: RuntimeChoice = orgStored ? storedChoice(orgStored) : { modelId: orgLegacy ?? fallback.modelId };
  const configuredId =
    requested?.modelId ??
    (scope !== orgScopeId ? (config.getRuntimeSelection(scope)?.modelId ?? config.getBaseModel(scope)) : null) ??
    configuredOrg.modelId;
  const unavailableReason = modelUnavailableReason(configuredId);
  if (unavailableReason) throw new NonRetryableTurnError(`${configuredId}: ${unavailableReason}`);
  const safeFallback = modelSupported(fallback.modelId) ? fallback : { modelId: defaultModel(fallback.modelId) };
  const org = modelSupported(configuredOrg.modelId) ? configuredOrg : safeFallback;
  const scopedStored = scope === orgScopeId ? null : config.getRuntimeSelection(scope);
  const scopedLegacy = scope === orgScopeId ? null : config.getBaseModel(scope);
  let inherited: RuntimeChoice = org;
  if (scopedStored) inherited = storedChoice(scopedStored);
  else if (scopedLegacy) inherited = { modelId: scopedLegacy };
  const choice = { ...inherited, ...requested };
  if (!modelSupported(choice.modelId)) {
    if (requested?.modelId) throw new NonRetryableTurnError(`runtime ${choice.modelId} is not approved`);
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
  const view: Pick<ScopedConfigStore, "getRuntimeSelection" | "getBaseModel" | "getPurposeRuntime"> = {
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

export function withResolvedRuntime(
  pi: Harness,
  resolve: (input: HarnessTurnInput, routedBy: (ruleId: string) => void) => RuntimeChoice | Promise<RuntimeChoice>,
): Harness {
  return {
    ...pi,
    models: { ...pi.models },
    turns: {
      ...pi.turns,
      async runTurn(input) {
        let routedBy: string | undefined;
        const choice = await resolve(input, (ruleId) => {
          routedBy = ruleId;
        });
        const label = safeModelMetadata(choice.modelId)?.label;
        input.onRuntime?.({
          modelId: choice.modelId,
          ...(label ? { label } : {}),
          ...(routedBy ? { change: { rule: routedBy } } : {}),
        });
        const judge = pi.models?.judge;
        return pi.turns.runTurn({
          ...input,
          runtime: choice,
          tools: input.runtimeControl
            ? { ...input.tools, runtime: (request, signal) => input.runtimeControl!(choice, request, signal) }
            : input.tools,
          ...(judge
            ? { governGoal: (goalInput: GoalGovernorInput) => governGoal(judge, goalInput, input.cancel) }
            : {}),
        });
      },
    },
  };
}
