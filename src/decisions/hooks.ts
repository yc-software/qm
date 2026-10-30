import type { ReplyRetraction } from "../harness/harness.ts";
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

const TURN_END_GUIDANCE_CHARS = 3_000;
const TURN_END_INPUT_CHARS = 1_500;
const TURN_END_REPLY_CHARS = 3_000;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;

export function replyFacts(reply: string): string[] {
  const prose = reply.replace(/```[\s\S]*?```/g, "");
  const paragraphs = prose.split(/\n\s*\n/).filter((block) => block.trim()).length;
  const tables = (prose.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) ?? []).length;
  const emDashes = (reply.match(/\u2014/g) ?? []).length;
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
    guidance ? clip(guidance, TURN_END_GUIDANCE_CHARS) : "(none)",
    "",
    "Latest message from the user:",
    clip(turn.input, TURN_END_INPUT_CHARS),
    "",
    "Measured in the draft reply:",
    ...replyFacts(turn.reply),
    "",
    "Draft reply:",
    clip(turn.reply, TURN_END_REPLY_CHARS),
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
  const run = async (rules: readonly DecisionRule[], hook: DecisionHook, state: string, turn: DecisionTurn) => {
    if (!rules.length) return undefined;
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
  return async (hook: DecisionHook, state: string, turn: DecisionTurn) => {
    const rules = (await store?.rules(hook)) ?? [];
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

type ReplyCheck = (draft: string) => Promise<ReplyRetraction | undefined>;
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
    const rules = (await store?.rules("turn_end")) ?? [];
    if (!rules.length) return undefined;
    const guidance = await context.guidance();
    return {
      enforce: rules.some((rule) => rule.mode === "enforce"),
      check: async (draft) => {
        const verdict = await decide("turn_end", turnEndState({ ...context, guidance, reply: draft }), context.turn);
        return verdict?.action === "retry" && verdict.message
          ? { reason: verdict.option.replace(/[_-]+/g, " "), message: verdict.message }
          : undefined;
      },
    };
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
