import { marked } from "marked";
import type { ReplyVerdict } from "../agent/agent.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  classifierKey,
  runHook,
  type DecisionBackend,
  type DecisionHook,
  type DecisionResult,
  type DecisionRule,
} from "./decisions.ts";
import type { DecisionStore } from "./store.ts";
import { swallowAs } from "../util/errors.ts";
import type { Tenant } from "../tenants/context.ts";

const HOOK_TIMEOUT_MS = 5_000;

export function turnStartState(turn: {
  input: string;
  surfaceName?: string;
  runtimePurpose?: string;
  runtime?: { modelId?: string };
  runtimePinned?: boolean;
  continueTurn?: boolean;
  scopeLabel: string;
  conversation?: string;
  context?: string;
}): string {
  const requested = turn.runtime?.modelId ? turn.runtime.modelId : "none (org default applies)";
  return [
    "Turn context:",
    `- surface: ${turn.surfaceName ?? "unknown"}`,
    `- purpose: ${turn.runtimePurpose ?? "interactive"}`,
    `- scope: ${turn.scopeLabel.split(":")[0]}`,
    ...(turn.conversation ? [`- conversation: ${turn.conversation}`] : []),
    `- requested runtime: ${requested}`,
    `- model account: ${turn.runtimePinned ? "the user's own provider account, which serves only the requested runtime" : "company"}`,
    `- continued turn: ${turn.continueTurn ? "yes, resuming an interrupted turn" : "no"}`,
    "",
    ...(turn.context ? ["Conversation so far:", turn.context, ""] : []),
    "Latest message:",
    turn.input,
  ].join("\n");
}

export function replyFacts(reply: string): string[] {
  const blocks = marked.lexer(reply);
  const paragraphs = blocks.filter((block) => block.type === "paragraph").length;
  const tables = blocks.filter((block) => block.type === "table").length;
  const emDashes = reply.split("\u2014").length - 1;
  return [
    `- paragraphs: ${paragraphs}`,
    `- markdown tables: ${tables}`,
    `- em dashes: ${emDashes}`,
    `- characters: ${reply.length}`,
  ];
}

export function turnEndState(turn: {
  surfaceName?: string;
  runtimePurpose?: string;
  guidance?: string;
  input: string;
  reply: string;
}): string {
  const guidance = turn.guidance?.trim();
  return [
    "Turn context:",
    `- surface: ${turn.surfaceName ?? "unknown"}`,
    `- purpose: ${turn.runtimePurpose ?? "interactive"}`,
    "",
    "Guidance for this conversation:",
    guidance || "(none)",
    "",
    "Latest message from the user:",
    turn.input,
    "",
    "Measured in the draft reply:",
    ...replyFacts(turn.reply),
    "",
    "Draft reply:",
    turn.reply,
  ].join("\n");
}

export interface DecisionTurn {
  tenant: Tenant;
  actorId?: string;
  scopeLabel: string;
  sessionId?: string;
  runId?: string;
  cancel?: AbortSignal;
}

export function createDecisionHooks(store: DecisionStore | undefined, backend: DecisionBackend, audit: AuditLog) {
  const run = async (rules: readonly DecisionRule[], hook: DecisionHook, state: string, turn: DecisionTurn) => {
    if (!rules.length) return [];
    const signal = AbortSignal.any([AbortSignal.timeout(HOOK_TIMEOUT_MS), ...(turn.cancel ? [turn.cancel] : [])]);
    const { results } = await runHook(turn.tenant, rules, hook, state, backend, signal);
    for (const result of results)
      audit.record(turn.tenant, {
        at: Date.now(),
        principalId: turn.actorId ?? "system",
        action: "decision.classify",
        resource: result.ruleId,
        scopeLabel: turn.scopeLabel,
        status: result.error ? "error" : result.action,
        detail: JSON.stringify({
          hook,
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
          ...(turn.runId ? { runId: turn.runId } : {}),
          ...result,
        }),
      });
    const confidence = (r: DecisionResult) => (r.error ? -1 : (r.probabilities[r.option] ?? 0));
    return results.filter((r) => r.mode === "enforce").sort((a, b) => confidence(b) - confidence(a));
  };
  return async (
    hook: DecisionHook,
    describe: string | (() => Promise<string>),
    turn: DecisionTurn,
  ): Promise<DecisionResult[]> => {
    const rules = (await store?.rules(turn.tenant, hook)) ?? [];
    if (!rules.length) return [];
    const state = typeof describe === "string" ? describe : await describe();
    const enforced = new Set(rules.filter((rule) => rule.mode === "enforce").map(classifierKey));
    const awaited = (rule: DecisionRule) => enforced.has(classifierKey(rule));
    void run(
      rules.filter((rule) => !awaited(rule)),
      hook,
      state,
      { ...turn, cancel: undefined },
    ).catch(swallowAs("decisions: observe-only rules", undefined));
    return run(rules.filter(awaited), hook, state, turn);
  };
}

type ReplyCheck = (draft: string) => Promise<ReplyVerdict | undefined>;
export type ReplyCheckFactory = (context: {
  surfaceName?: string;
  runtimePurpose?: string;
  guidance: () => Promise<string>;
  input: string;
  turn: DecisionTurn;
}) => Promise<{ enforce: boolean; check: ReplyCheck } | undefined>;

export function createReplyCheck(
  store: Pick<DecisionStore, "rules"> | undefined,
  decide: ReturnType<typeof createDecisionHooks>,
): ReplyCheckFactory {
  return async (context) => {
    const rules = (await store?.rules(context.turn.tenant, "turn_end")) ?? [];
    if (!rules.length) return undefined;
    const guidance = await context.guidance();
    return {
      enforce: rules.some((rule) => rule.mode === "enforce"),
      check: async (draft) => {
        const verdict = (
          await decide("turn_end", turnEndState({ ...context, guidance, reply: draft }), context.turn)
        ).find((r) => r.action === "retry" || r.action === "prod");
        return (verdict?.action === "retry" || verdict?.action === "prod") && verdict.message
          ? {
              action: verdict.action,
              reason: verdict.option.replaceAll("_", " ").replaceAll("-", " "),
              message: verdict.message,
            }
          : undefined;
      },
    };
  };
}

export function turnStartOnce(
  decide: (hook: DecisionHook, describe: () => Promise<string>, turn: DecisionTurn) => Promise<DecisionResult[]>,
  facts: () => Promise<Parameters<typeof turnStartState>[0]>,
  turn: DecisionTurn,
): () => Promise<DecisionResult[]> {
  let results: Promise<DecisionResult[]> | undefined;
  return () =>
    (results ??= decide("turn_start", async () => turnStartState(await facts()), turn).catch(
      swallowAs("decisions: turn_start", []),
    ));
}

export async function routeTurnRuntime<C extends { modelId: string }>(
  decision: DecisionResult | undefined,
  route: (runtime: NonNullable<DecisionResult["runtime"]>) => Promise<C>,
  requested: () => Promise<C>,
): Promise<{ choice: C; routedBy?: string }> {
  if (!decision?.runtime) return { choice: await requested() };
  const [choice, otherwise] = await Promise.all([
    route(decision.runtime),
    requested().catch(swallowAs("decisions: requested runtime", undefined)),
  ]);
  const changed = !!otherwise && otherwise.modelId !== choice.modelId;
  return changed ? { choice, routedBy: decision.ruleId } : { choice };
}
