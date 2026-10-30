import { isHarnessId, safeModelMetadata, type HarnessId } from "../model/pi-models.ts";
import type { SessionEntry } from "../types.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult, RuntimeChoice } from "../agent/harness.ts";
import { createGrindMeter, meterGrindSpend } from "../agent/grind.ts";
import {
  bankGoalTurn,
  enforceGoal,
  governGoal,
  goalWorkFromEntries,
  type GoalGovernorInput,
  type GoalRecord,
  type GovernorVerdict,
} from "../agent/goal.ts";

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
  let saved: GoalRecord | undefined;
  const startedAt = Date.now();
  const meter = createGrindMeter(startedAt);
  let segment = { goal: input.goal ?? undefined, assignedAt: input.goal?.createdAt };
  const replacedThisSegment = () => !!segment.goal && segment.goal.createdAt !== segment.assignedAt;
  const dispatched: HarnessTurnInput = {
    ...input,
    goalMeter: meter,
    recordLlmRequest: (rec, signal) => {
      if (!replacedThisSegment()) meterGrindSpend(meter, rec.usage ?? null);
      return input.recordLlmRequest?.(rec, signal);
    },
    emit: async (entry) => {
      const stored = await input.emit(entry);
      emitted.push(stored);
      return stored;
    },
    saveGoal: async (goal) => {
      saved = goal;
      await input.saveGoal?.(goal);
    },
  };
  let result = await adapter.turns.runTurn(dispatched);
  const goal: GoalRecord | null = saved ?? input.goal ?? null;
  if (!goal) return result;
  const account = () => {
    if (replacedThisSegment()) return;
    meter.turns += result.modelCalls ?? 1;
    const tokens = inputTokens(result);
    meter.tokens += tokens;
    if (goal.status !== "paused") goal.tokensUsed += tokens;
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
    ...(input.governGoal
      ? {
          govern: (previous: GovernorVerdict | undefined) =>
            input.governGoal!({
              objective: goal.objective,
              trigger: "checkpoint",
              recentWork: goalWorkFromEntries([...input.history.slice(-40), ...emitted]),
              ...(previous ? { previous } : {}),
            }),
        }
      : {}),
    ...(input.goalInbox ? { inbox: input.goalInbox } : {}),
    beforePrompt: () => {
      console.error(`[goal] continuation session=${input.session.id} harness=${harnessId} turns=${meter.turns}`);
    },
    prompt: async (note) => {
      const remaining = remainingWallMs();
      segment = { goal, assignedAt: goal.createdAt };
      result = await adapter.turns.runTurn({
        ...dispatched,
        continueTurn: undefined,
        input: note,
        history: [...input.history, ...emitted],
        goal,
        goalContinuation: true,
        ...(remaining !== undefined ? { turnWallClockMs: Math.max(1, remaining) } : {}),
      });
      account();
      return blocked() ? "halted" : "ok";
    },
  });
  if (saved && saved !== goal) return result;
  bankGoalTurn(goal, startedAt);
  if (result.stopped && (result.stoppedByUser || !input.cancel?.aborted) && goal.status === "active") {
    goal.status = "paused";
    goal.updatedAt = Date.now();
  }
  await dispatched.saveGoal!(goal);
  return result;
}

export function createHarnessRouter(
  adapters: ReadonlyMap<HarnessId, Harness>,
  utility: Harness,
  resolve: (input: HarnessTurnInput, routedBy: (ruleId: string) => void) => RuntimeChoice | Promise<RuntimeChoice>,
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
        let routedBy: string | undefined;
        const choice = await resolve(input, (ruleId) => {
          routedBy = ruleId;
        });
        const label = safeModelMetadata(choice.modelId)?.label;
        input.onRuntime?.({
          harnessId: choice.harnessId,
          modelId: choice.modelId,
          ...(label ? { label } : {}),
          ...(routedBy ? { change: { rule: routedBy } } : {}),
        });
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
                governGoal: (goalInput: GoalGovernorInput) => governGoal(judge, goalInput, input.cancel),
              }
            : {}),
        };
        return adapter.profile.capabilities.has("goal-enforcement")
          ? adapter.turns.runTurn(dispatched)
          : runTurnEnforcingGoal(adapter, dispatched, choice.harnessId);
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
