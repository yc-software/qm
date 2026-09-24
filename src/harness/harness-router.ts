import type { ScopedConfigStore } from "../resolution/config-store.ts";
import {
  defaultModelForHarness,
  defaultInteractiveThinkingLevel,
  fastModeModelIds,
  harnessSupportsFastMode,
  isHarnessId,
  modelSupportedByHarness,
  resolveModel,
  thinkingLevelsForHarness,
  modelUnavailableReason,
  type HarnessId,
} from "../model/pi-models.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult, RuntimeChoice } from "./harness.ts";
import { withTapedEntryMirrors } from "./harness-shared.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { createGrindMeter } from "./grind.ts";
import { enforceGoal, latestGoalRecord, rehydrateOpenGoal, type GoalRecord } from "./goal.ts";

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
  const enforced = await enforceGoal<"ok" | "halted">({
    goal,
    meter,
    outcome: blocked() ? "halted" : "ok",
    ok: "ok",
    toolCalls: () => emitted.filter((entry) => entry.type === "tool_call").length,
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
  if (result.stopped && goal.status === "active") {
    goal.status = "paused";
    goal.updatedAt = Date.now();
  }
  await dispatched.emit({ type: "system", payload: { kind: "goal", goal: { ...goal } }, scopeLabel: input.scopeLabel });
  if (!enforced.waiverNote) return result;
  await dispatched.emit({ type: "assistant", payload: { text: enforced.waiverNote }, scopeLabel: input.scopeLabel });
  return { ...result, reply: [result.reply, enforced.waiverNote].filter(Boolean).join("\n\n") };
}

function normalizeRuntimeChoice(choice: RuntimeChoice): RuntimeChoice {
  return {
    harnessId: choice.harnessId,
    modelId: choice.modelId,
    ...(choice.effortLevel && thinkingLevelsForHarness(choice.harnessId).includes(choice.effortLevel)
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
  config: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel">,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
): RuntimeChoice {
  const approved = config.getApprovedHarnesses() ?? [fallback.harnessId];
  if (approved.length === 0) throw new NonRetryableTurnError("No harnesses are approved");
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
): Promise<RuntimeChoice> {
  const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
  const [orgStored, scopedStored, orgLegacy, scopedLegacy] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    config.getBaseModelOwnDurable(orgScopeId),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
  ]);
  if (hydrateModelCatalog) {
    const candidates = [requested?.modelId, scopedStored?.modelId, orgStored?.modelId];
    if (candidates.some((modelId) => modelId && !resolveModel(modelId))) await hydrateModelCatalog();
  }
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
  return resolveRuntimeChoice(view, orgScopeId, scope, fallback, requested);
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
        const resolved = await resolve(input);
        const model = resolveModel(resolved.modelId);
        const choice: RuntimeChoice = {
          ...resolved,
          effortLevel:
            resolved.effortLevel ??
            (resolved.harnessId === "pi" && model ? defaultInteractiveThinkingLevel(model) : "auto"),
          fastMode: resolved.fastMode ?? false,
        };
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const prior = lastHarness.get(input.session.id);
        if (prior && prior !== choice.harnessId) {
          await adapters.get(prior)?.turns.resetSession?.(input.session.id);
          await adapter.turns.resetSession?.(input.session.id);
        }
        lastHarness.set(input.session.id, choice.harnessId);
        if (input.runId && input.runtimeActorId)
          await input.emit({
            type: "system",
            payload: {
              kind: "runtime_active",
              runId: input.runId,
              actorId: input.runtimeActorId,
              choice,
              modelAccount: input.runtimeAccount,
            },
            scopeLabel: input.scopeLabel,
          });
        const dispatched: HarnessTurnInput = {
          ...input,
          runtime: choice,
          tools: {
            ...input.tools,
            ...(input.runtimeControl
              ? { runtime: (request, signal) => input.runtimeControl!(choice, request, signal) }
              : {}),
            ...(input.tools.sessionSyscalls
              ? {
                  sessionSyscalls: {
                    ...input.tools.sessionSyscalls,
                    open: (request) => input.tools.sessionSyscalls!.open(request, choice),
                  },
                }
              : {}),
          },
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
