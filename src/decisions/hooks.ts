import type { AuditLog } from "../audit/audit-log.ts";
import { runHook, type DecisionBackend, type DecisionHook } from "./decisions.ts";
import type { DecisionStore } from "./store.ts";

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
    `- continued turn: ${turn.continueTurn ? "yes, resuming after a recorded tool result" : "no"}`,
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
