import type { ScopedConfigStore, RuntimePurpose } from "../resolution/config-store.ts";
import {
  defaultModelForHarness,
  fastModeModelIds,
  harnessSupportsFastMode,
  isHarnessId,
  modelSupportedByHarness,
  resolveModel,
  parseEffort,
  parseRuntimeChoice,
  effortNotOfferedMessage,
  modelUnavailableReason,
  type EffortLevel,
  type HarnessId,
} from "../model/pi-models.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult, RequestedRuntime, RuntimeChoice } from "./harness.ts";
import { withTapedEntryMirrors } from "./harness-shared.ts";
import { NON_INTERACTIVE_THINKING_LEVEL, NON_INTERACTIVE_FAST_MODE } from "../core/turn-options.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { createGrindMeter } from "./grind.ts";
import {
  bankGoalTurn,
  enforceGoal,
  goalSnapshotPayload,
  latestGoalRecord,
  rehydrateOpenGoal,
  verifyGoalCompletion,
  type GoalRecord,
} from "./goal.ts";

const GOAL_ROUND_MIN_WALL_MS = 30_000;

function turnCompleted(result: HarnessTurnResult): boolean {
  return !result.stopped && !result.runtimeHandoff && !result.pausedOnApproval && !result.pendingApprovals?.length;
}

function inputTokens(result: HarnessTurnResult): number {
  const usage = result.cacheUsage;
  return usage ? usage.cacheRead + usage.cacheWrite + usage.uncachedInput : 0;
}

async function runTurnEnforcingGoal(
  adapter: Harness,
  input: HarnessTurnInput,
  harnessId: HarnessId,
): Promise<HarnessTurnResult> {
  const emitted: SessionEntry[] = [];
  const dispatched: HarnessTurnInput = {
    ...input,
    emit: async (entry) => {
      const stored = await input.emit(entry);
      emitted.push(stored);
      return stored;
    },
  };
  const startedAt = Date.now();
  const meter = createGrindMeter(startedAt);
  let result = await adapter.turns.runTurn(dispatched);
  const goal: GoalRecord | null = latestGoalRecord(emitted) ?? rehydrateOpenGoal(input.history);
  if (!goal) return result;
  const account = () => {
    meter.turns += result.modelCalls ?? 1;
    const tokens = inputTokens(result);
    meter.tokens += tokens;
    goal.tokensUsed += tokens;
  };
  account();
  const remainingWallMs = () =>
    input.turnWallClockMs && input.turnWallClockMs > 0 ? input.turnWallClockMs - (Date.now() - startedAt) : undefined;
  const blocked = () => {
    const remaining = remainingWallMs();
    return (
      !!input.cancel?.aborted ||
      !turnCompleted(result) ||
      (remaining !== undefined && remaining < GOAL_ROUND_MIN_WALL_MS)
    );
  };
  await enforceGoal<"ok" | "halted">({
    goal,
    meter,
    outcome: blocked() ? "halted" : "ok",
    ok: "ok",
    blocked,
    beforePrompt: () => {
      console.error(`[goal] continuation session=${input.session.id} harness=${harnessId} turns=${meter.turns}`);
    },
    prompt: async (note) => {
      const remaining = remainingWallMs();
      result = await adapter.turns.runTurn({
        ...dispatched,
        input: note,
        history: [...input.history, ...emitted],
        goal,
        ...(remaining !== undefined ? { turnWallClockMs: Math.max(1, remaining) } : {}),
      });
      account();
      return blocked() ? "halted" : "ok";
    },
  });
  if (result.stopped && (result.stoppedByUser || !input.cancel?.aborted) && goal.status === "active") {
    goal.status = "paused";
    goal.updatedAt = Date.now();
  }
  bankGoalTurn(goal, startedAt);
  await dispatched.emit({ type: "system", payload: goalSnapshotPayload(goal), scopeLabel: input.scopeLabel });
  return result;
}

type StoredRuntime = { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean };

function resolvedEffort(
  target: { harnessId: HarnessId; modelId: string },
  requested: string | undefined,
  inherited: StoredRuntime | undefined,
): EffortLevel | undefined {
  const level = requested ?? inherited?.effortLevel;
  if (level === undefined) return undefined;
  const effort = parseEffort(target.harnessId, target.modelId, level);
  if (!effort)
    throw new NonRetryableTurnError(
      effortNotOfferedMessage(target.harnessId, target.modelId, level, requested === undefined),
    );
  return effort;
}

function normalizeRuntimeChoice(
  target: { harnessId: HarnessId; modelId: string; fastMode?: boolean },
  effortLevel: EffortLevel | undefined,
): RuntimeChoice {
  return {
    harnessId: target.harnessId,
    modelId: target.modelId,
    ...(effortLevel ? { effortLevel } : {}),
    ...(typeof target.fastMode === "boolean"
      ? {
          fastMode:
            target.fastMode && harnessSupportsFastMode(target.harnessId) && fastModeModelIds().includes(target.modelId),
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
  requested?: RequestedRuntime,
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
    if (choice.fastMode && (!harnessSupportsFastMode(choice.harnessId) || !fastModeModelIds().includes(choice.modelId)))
      throw new NonRetryableTurnError(`fast mode is not supported by ${choice.harnessId}/${choice.modelId}`);
    const target = { ...choice, harnessId: choice.harnessId };
    return normalizeRuntimeChoice(
      target,
      resolvedEffort(target, explicit.effortLevel as string | undefined, purposeRuntime),
    );
  }
  if (purpose === "cron")
    requested = {
      defaultEffortLevel: NON_INTERACTIVE_THINKING_LEVEL,
      fastMode: NON_INTERACTIVE_FAST_MODE,
      ...requested,
    };

  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  const configuredOrg: StoredRuntime & { harnessId: HarnessId } =
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
  const org: StoredRuntime & { harnessId: HarnessId } =
    approved.includes(configuredOrg.harnessId) &&
    modelSupportedByHarness(configuredOrg.modelId, configuredOrg.harnessId)
      ? configuredOrg
      : safeFallback;
  const scopedStored = scope === orgScopeId ? null : config.getRuntimeSelection(scope);
  const scopedLegacy = scope === orgScopeId ? null : config.getBaseModel(scope);
  let inherited: StoredRuntime & { harnessId: HarnessId } = org;
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
  let base = inherited;
  const { defaultEffortLevel, ...overrides } = requested ?? {};
  let target = { ...inherited, ...overrides };
  if (!approved.includes(target.harnessId) || !modelSupportedByHarness(target.modelId, target.harnessId)) {
    if (requested?.harnessId || requested?.modelId)
      throw new NonRetryableTurnError(`runtime ${target.harnessId}/${target.modelId} is not approved`);
    base = org;
    target = { ...org, ...overrides };
  }
  const effort =
    defaultEffortLevel !== undefined && overrides.effortLevel === undefined
      ? parseEffort(target.harnessId, target.modelId, defaultEffortLevel)
      : resolvedEffort(target, overrides.effortLevel, base);
  return normalizeRuntimeChoice(target, effort);
}

export async function resolvePinnedRuntime(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  requested: RequestedRuntime & { harnessId: HarnessId; modelId: string },
): Promise<RuntimeChoice> {
  const { fastMode, defaultEffortLevel, ...rest } = requested;
  const pinned = parseRuntimeChoice(rest);
  if (!pinned.ok) throw new NonRetryableTurnError(pinned.message);
  const [orgStored, scopedStored, scopedLegacy] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
  ]);
  const orgInherited = !scopedLegacy && orgStored && isHarnessId(orgStored.harnessId) ? orgStored : undefined;
  const inherited = scopedStored && isHarnessId(scopedStored.harnessId) ? scopedStored : orgInherited;
  const saved =
    pinned.choice.effortLevel === undefined && defaultEffortLevel === undefined ? inherited?.effortLevel : undefined;
  const effortLevel =
    pinned.choice.effortLevel ??
    (saved === undefined
      ? parseEffort(pinned.choice.harnessId, pinned.choice.modelId, defaultEffortLevel)
      : resolvedEffort(pinned.choice, undefined, { ...pinned.choice, effortLevel: saved }));
  return {
    ...pinned.choice,
    ...(effortLevel ? { effortLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: RequestedRuntime,
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

export function createHarnessRouter(
  adapters: ReadonlyMap<HarnessId, Harness>,
  utility: Harness,
  resolve: (input: HarnessTurnInput) => RuntimeChoice | Promise<RuntimeChoice>,
): Harness {
  const lastHarness = new Map<string, HarnessId>();
  return {
    profile: utility.profile,
    models: {
      ...utility.models,
      async screenSecurity(input) {
        const adapter = input.harnessId && isHarnessId(input.harnessId) ? adapters.get(input.harnessId) : utility;
        return adapter?.models.screenSecurity?.(input);
      },
    },
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
        const judge = adapter.models?.judge;
        const dispatched: HarnessTurnInput = {
          ...input,
          runtime: choice,
          tools: input.runtimeControl
            ? { ...input.tools, runtime: (request, signal) => input.runtimeControl!(choice, request, signal) }
            : input.tools,
          ...(judge
            ? {
                verifyGoal: (objective: string, evidence: string) =>
                  verifyGoalCompletion(judge, objective, evidence, input.cancel),
              }
            : {}),
        };
        const taped = adapter.profile.capabilities.has("native-tape") ? dispatched : withTapedEntryMirrors(dispatched);
        return adapter.profile.capabilities.has("goal-enforcement")
          ? adapter.turns.runTurn(taped)
          : runTurnEnforcingGoal(adapter, taped, choice.harnessId);
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
