import type { HarnessTurnInput, HarnessTurnResult } from "../harness/harness.ts";
import type { ProviderTurnError } from "../core/turn-error.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { runHook, type DecisionBackend, type DecisionHook, type DecisionResult } from "./decisions.ts";
import type { DecisionStore } from "./store.ts";
import { swallowAs } from "../util/errors.ts";

const HOOK_TIMEOUT_MS = 5_000;

export function turnStartState(turn: {
  input: string;
  surfaceName?: string;
  runtimePurpose?: string;
  runtime?: { harnessId?: string; modelId?: string };
  runtimePinned?: boolean;
  continueTurn?: boolean;
  scopeLabel: string;
}): string {
  const requested = turn.runtime?.modelId
    ? [turn.runtime.harnessId, turn.runtime.modelId].filter(Boolean).join("/")
    : "none (org default applies)";
  return [
    "Turn context:",
    `- surface: ${turn.surfaceName ?? "unknown"}`,
    `- purpose: ${turn.runtimePurpose ?? "interactive"}`,
    `- scope: ${turn.scopeLabel.split(":")[0]}`,
    `- requested runtime: ${requested}`,
    `- model account: ${turn.runtimePinned ? "the user's own provider account, which serves only the requested runtime" : "company"}`,
    `- continued turn: ${turn.continueTurn ? "yes, resuming an interrupted turn" : "no"}`,
    "",
    "Latest message:",
    turn.input,
  ].join("\n");
}

export interface DecisionTurn {
  actorId?: string;
  scopeLabel: string;
  sessionId: string;
  runId?: string;
  cancel?: AbortSignal;
}

export function createDecisionHooks(store: DecisionStore | undefined, backend: DecisionBackend, audit: AuditLog) {
  return async (hook: DecisionHook, state: string, turn: DecisionTurn) => {
    const rules = (await store?.rules(hook)) ?? [];
    if (!store || !rules.length) return undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(HOOK_TIMEOUT_MS), ...(turn.cancel ? [turn.cancel] : [])]);
    const { decisive, results } = await runHook(rules, hook, state, backend, signal);
    for (const result of results)
      audit.record({
        at: Date.now(),
        principalId: turn.actorId ?? "system",
        action: "decision.classify",
        resource: result.ruleId,
        scopeLabel: turn.scopeLabel,
        status: result.error ? "error" : result.action,
        detail: JSON.stringify({
          hook,
          sessionId: turn.sessionId,
          ...(turn.runId ? { runId: turn.runId } : {}),
          ...result,
        }),
      });
    return decisive;
  };
}

export async function routeTurnRuntime<C extends { harnessId: string; modelId: string }>(
  decision: DecisionResult | undefined,
  route: (runtime: NonNullable<DecisionResult["runtime"]>) => Promise<C>,
  requested: () => Promise<C>,
): Promise<{ choice: C; routedBy?: string }> {
  if (!decision?.runtime) return { choice: await requested() };
  const [choice, otherwise] = await Promise.all([
    route(decision.runtime),
    requested().catch(swallowAs("decisions: requested runtime", undefined)),
  ]);
  const changed = !!otherwise && (otherwise.harnessId !== choice.harnessId || otherwise.modelId !== choice.modelId);
  return changed ? { choice, routedBy: decision.ruleId } : { choice };
}

export function turnEndState(turn: Parameters<typeof turnStartState>[0], reply: string, refusal?: string): string {
  return JSON.stringify({
    request: turn.input.slice(-2_000),
    runtime: turn.runtime,
    response: reply.slice(-5_000),
    ...(refusal ? { providerError: { code: "refusal", message: refusal.slice(0, 500) } } : {}),
  });
}

export function createTurnEndHook(decide: ReturnType<typeof createDecisionHooks>) {
  return async (
    input: HarnessTurnInput,
    result: HarnessTurnResult,
    error?: ProviderTurnError,
  ): Promise<HarnessTurnResult> => {
    if (!input.runtimeControl || !input.runtime?.harnessId || !input.runtime.modelId || input.readOnly) return result;
    const decision = await decide("turn_end", turnEndState(input, result.reply, error?.message), {
      actorId: input.runtimeActorId,
      scopeLabel: input.scopeLabel,
      sessionId: input.session.id,
      runId: input.runId,
      cancel: input.cancel,
    });
    if (!decision?.runtime || decision.runtime.modelId === input.runtime.modelId) return result;
    const switched = await input.runtimeControl(
      { ...input.runtime, harnessId: input.runtime.harnessId, modelId: input.runtime.modelId },
      {
        action: "set",
        harness: "pi",
        model: decision.runtime.modelId,
        effort: decision.runtime.effortLevel ?? "auto",
        fastMode: decision.runtime.fastMode ?? false,
        lifetime: "task",
      },
      input.cancel,
    );
    if (!switched.ok) {
      await input.emit({
        type: "tool_result",
        scopeLabel: input.scopeLabel,
        payload: { tool: "runtime", action: "set", decisionRule: decision.ruleId, ...switched },
      });
      return result;
    }
    if (!switched.handoff) return result;
    const fromSeq = input.history.at(-1)?.seq;
    if (typeof fromSeq === "number") {
      await input.emit({
        type: "system",
        scopeLabel: input.scopeLabel,
        payload: {
          kind: "retraction",
          fromSeq,
          cause: error ? "provider_refusal" : "refusal_reply",
          decisionRule: decision.ruleId,
        },
      });
    }
    await input.emit({
      type: "tool_result",
      scopeLabel: input.scopeLabel,
      payload: {
        tool: "runtime",
        action: "set",
        ok: true,
        runtimeHandoff: switched.handoff,
        runId: input.runId,
        actorId: input.runtimeActorId,
        decisionRule: decision.ruleId,
      },
    });
    await input.emit({
      type: "system",
      scopeLabel: input.scopeLabel,
      payload: {
        text: `A refusal triggered a switch to ${switched.handoff.choice.modelId}. Prefer this runtime for the rest of this conversation; switch again if the user asks or the task needs it.`,
      },
    });
    return { ...result, runtimeHandoff: switched.handoff };
  };
}
