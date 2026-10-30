import type { AuditLog } from "../audit/audit-log.ts";
import {
  classifierKey,
  MAX_STATE_CHARS,
  runHook,
  type DecisionBackend,
  type DecisionHook,
  type DecisionResult,
  type DecisionRule,
} from "./decisions.ts";
import type { DecisionStore } from "./store.ts";
import { swallowAs } from "../util/errors.ts";
import { headSlice, tailSlice } from "../util/text.ts";

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

function cutMiddle(text: string, room: number): string {
  if (text.length <= room) return text;
  const width = `\n[${text.length} characters cut]\n`.length;
  const keep = Math.max(0, room - width);
  const marker = `\n[${text.length - keep} characters cut]\n`;
  return headSlice(text, Math.ceil(keep / 2)) + marker + tailSlice(text, Math.floor(keep / 2));
}

function fairShares(sizes: readonly number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  let open = sizes.map((_, i) => i);
  let left = budget;
  while (open.length) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => sizes[i]! <= share);
    if (!fits.length) {
      for (const i of open) shares[i] = share;
      break;
    }
    for (const i of fits) {
      shares[i] = sizes[i]!;
      left -= sizes[i]!;
    }
    open = open.filter((i) => sizes[i]! > share);
  }
  return shares;
}

export function turnEndState(turn: {
  surfaceName?: string;
  scopeLabel: string;
  guidance?: string;
  input: string;
  reply: string;
}): string {
  const hasGuidance = Boolean(turn.guidance?.trim());
  const render = (guidance: string, reply: string, input: string) =>
    [
      "Turn context:",
      `- surface: ${turn.surfaceName ?? "unknown"}`,
      `- scope: ${turn.scopeLabel.split(":")[0]}`,
      "",
      hasGuidance
        ? `Standing instructions this conversation's replies must follow:\n${guidance}`
        : "This conversation has no standing instructions of its own.",
      "",
      "Latest message:",
      input,
      "",
      "Draft reply, written but not yet delivered:",
      reply,
    ].join("\n");
  const sections = [hasGuidance ? turn.guidance!.trim() : "", turn.reply.trim(), turn.input.trim()];
  const shares = fairShares(
    sections.map((text) => text.length),
    MAX_STATE_CHARS - render("", "", "").length,
  );
  const [guidance, reply, input] = sections.map((text, i) => cutMiddle(text, shares[i]!));
  return render(guidance!, reply!, input!);
}

export interface DecisionTurn {
  actorId?: string;
  scopeLabel: string;
  sessionId: string;
  runId?: string;
  cancel?: AbortSignal;
}

export interface DecisionHooks {
  mode(hook: DecisionHook): Promise<"enforce" | "observe" | undefined>;
  run(hook: DecisionHook, state: string, turn: DecisionTurn): Promise<DecisionResult | undefined>;
}

export function createDecisionHooks(
  store: DecisionStore | undefined,
  backend: DecisionBackend,
  audit: AuditLog,
): DecisionHooks {
  const classify = async (rules: readonly DecisionRule[], hook: DecisionHook, state: string, turn: DecisionTurn) => {
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
  const rulesFor = async (hook: DecisionHook) => (await store?.rules(hook)) ?? [];
  return {
    mode: async (hook) => {
      const modes = new Set((await rulesFor(hook)).map((rule) => rule.mode));
      if (modes.has("enforce")) return "enforce";
      if (modes.has("observe")) return "observe";
      return undefined;
    },
    run: async (hook, state, turn) => {
      const rules = await rulesFor(hook);
      const enforced = new Set(rules.filter((rule) => rule.mode === "enforce").map(classifierKey));
      const awaited = (rule: DecisionRule) => enforced.has(classifierKey(rule));
      void classify(
        rules.filter((rule) => !awaited(rule)),
        hook,
        state,
        { ...turn, cancel: undefined },
      ).catch(swallowAs("decisions: observe-only rules", undefined));
      return classify(rules.filter(awaited), hook, state, turn);
    },
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
