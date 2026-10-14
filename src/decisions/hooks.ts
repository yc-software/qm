import type { AuditLog } from "../audit/audit-log.ts";
import { runHook, type DecisionBackend, type DecisionHook } from "./decisions.ts";
import type { DecisionStore } from "./store.ts";

const HOOK_TIMEOUT_MS = 5_000;

export async function routeTurnRuntime<R extends object>(
  requested: R | undefined,
  continueTurn: boolean | undefined,
  classify: () => Promise<{ runtime?: R } | undefined>,
): Promise<R | undefined> {
  if (continueTurn) return requested;
  return (await classify())?.runtime ?? requested;
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
