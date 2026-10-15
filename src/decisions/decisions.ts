const DECISION_HOOK_POINTS = {
  user_input: { actions: ["allow", "block"], decide: "most_restrictive" },
  tool_response: { actions: ["allow", "block"], decide: "most_restrictive" },
  turn_start: { actions: ["keep", "use_runtime"], decide: "most_confident" },
  goal_check: { actions: ["continue", "complete", "step_back", "pause"], decide: "most_confident" },
} as const satisfies Record<string, { actions: readonly string[]; decide: "most_restrictive" | "most_confident" }>;
export type DecisionHook = keyof typeof DECISION_HOOK_POINTS;
type DecisionAction<H extends DecisionHook = DecisionHook> = (typeof DECISION_HOOK_POINTS)[H]["actions"][number];
const DECISION_HOOKS = Object.keys(DECISION_HOOK_POINTS) as DecisionHook[];
const LIVE_DECISION_HOOKS: readonly DecisionHook[] = ["turn_start"];
const rank = (hook: DecisionHook, action: string) =>
  (DECISION_HOOK_POINTS[hook].actions as readonly string[]).indexOf(action);

interface RuntimeParams {
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}

const DECISION_PROTOCOLS = ["chat-completions", "decisions", "systemone"] as const;
const DECISION_MODES = ["off", "observe", "enforce"] as const;

export interface DecisionProvider {
  id: string;
  protocol: (typeof DECISION_PROTOCOLS)[number];
  baseUrl?: string;
  credential?: string;
}

interface DecisionModelRef {
  provider: string;
  model: string;
}

interface DecisionOption {
  description: string;
  action: DecisionAction;
  message?: string;
  runtime?: RuntimeParams;
}

export interface DecisionRule {
  id: string;
  hook: DecisionHook;
  question: string;
  options: Record<string, DecisionOption>;
  model: DecisionModelRef;
  mode: (typeof DECISION_MODES)[number];
  onError: string;
}

export interface DecisionResult {
  ruleId: string;
  option: string;
  action: DecisionAction;
  message?: string;
  runtime?: RuntimeParams;
  probabilities: Record<string, number>;
  mode: DecisionRule["mode"];
  error?: string;
}

export interface DecisionQuestion {
  question: string;
  options: Record<string, string>;
}

export interface DecisionBackend {
  choose(input: {
    questions: Record<string, DecisionQuestion>;
    state: string;
    model: DecisionModelRef;
    signal: AbortSignal;
  }): Promise<Record<string, Record<string, number> | Error>>;
}

const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RULES = 32;
const MAX_OPTIONS = 8;
const MAX_TEXT_CHARS = 500;
const MAX_STATE_CHARS = 8_000;
const MAX_RULE_TEXT_CHARS = 16_000;

export function parseDecisionProvider(raw: unknown): { provider: DecisionProvider } | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return { error: `provider id must match ${ID}` };
  if (!DECISION_PROTOCOLS.includes(r.protocol as DecisionProvider["protocol"]))
    return { error: `provider ${r.id}: protocol must be one of ${DECISION_PROTOCOLS.join(", ")}` };
  if ((r.baseUrl === undefined) !== (r.credential === undefined))
    return { error: `provider ${r.id}: set baseUrl and credential together, or neither to use the model gateway` };
  if (r.credential !== undefined && (typeof r.credential !== "string" || !ID.test(r.credential)))
    return { error: `provider ${r.id}: credential must name an org service credential` };
  if (r.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(String(r.baseUrl));
    } catch {
      return { error: `provider ${r.id}: baseUrl is not a URL` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return { error: `provider ${r.id}: baseUrl must be http(s)` };
  }
  return {
    provider: {
      id: r.id,
      protocol: r.protocol as DecisionProvider["protocol"],
      ...(r.baseUrl !== undefined ? { baseUrl: String(r.baseUrl), credential: r.credential as string } : {}),
    },
  };
}

export function parseDecisionRule(
  raw: unknown,
  providers: readonly DecisionProvider[],
  modelIds: ReadonlySet<string>,
): { rule: DecisionRule } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "rule must be an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !RULE_ID.test(r.id)) return { error: `rule id must match ${RULE_ID}` };
  if (!DECISION_HOOKS.includes(r.hook as DecisionHook))
    return { error: `${r.id}: hook must be one of ${DECISION_HOOKS.join(", ")}` };
  if (!LIVE_DECISION_HOOKS.includes(r.hook as DecisionHook))
    return { error: `${r.id}: hook ${String(r.hook)} is not available yet; use ${LIVE_DECISION_HOOKS.join(", ")}` };
  if (typeof r.question !== "string" || !r.question.trim()) return { error: `${r.id}: question is required` };
  if (!DECISION_MODES.includes(r.mode as DecisionRule["mode"]))
    return { error: `${r.id}: mode must be one of ${DECISION_MODES.join(", ")}` };
  if (typeof r.options !== "object" || r.options === null || Array.isArray(r.options))
    return { error: `${r.id}: options must be an object` };
  const options: Record<string, DecisionOption> = {};
  for (const [key, opt] of Object.entries(r.options as Record<string, unknown>)) {
    if (!ID.test(key)) return { error: `${r.id}: option ${key} must match ${ID}` };
    const o = opt as Record<string, unknown> | null;
    if (typeof o?.description !== "string" || !o.description.trim() || o.description.length > MAX_TEXT_CHARS)
      return { error: `${r.id}.${key}: description is required` };
    const allowed = DECISION_HOOK_POINTS[r.hook as DecisionHook].actions as readonly string[];
    if (!allowed.includes(o.action as string))
      return { error: `${r.id}.${key}: action at ${String(r.hook)} must be one of ${allowed.join(", ")}` };
    if (o.message !== undefined && (typeof o.message !== "string" || o.message.length > MAX_TEXT_CHARS))
      return { error: `${r.id}.${key}: message must be a string of at most ${MAX_TEXT_CHARS} characters` };
    const rt = o.runtime as Record<string, unknown> | undefined;
    if ((o.action === "use_runtime") !== (rt !== undefined))
      return { error: `${r.id}.${key}: runtime is required with use_runtime and only allowed there` };
    if (
      rt !== undefined &&
      (typeof rt !== "object" ||
        rt === null ||
        typeof rt.modelId !== "string" ||
        !rt.modelId.trim() ||
        (rt.effortLevel !== undefined && typeof rt.effortLevel !== "string") ||
        (rt.fastMode !== undefined && typeof rt.fastMode !== "boolean"))
    )
      return { error: `${r.id}.${key}: runtime needs modelId and optional effortLevel/fastMode` };
    if (rt && !modelIds.has(rt.modelId as string))
      return { error: `${r.id}.${key}: model ${String(rt.modelId)} is not in this deployment's model catalog` };
    options[key] = {
      description: o.description,
      action: o.action as DecisionAction,
      ...(o.message ? { message: o.message } : {}),
      ...(rt
        ? {
            runtime: {
              modelId: rt.modelId as string,
              ...(rt.effortLevel !== undefined ? { effortLevel: rt.effortLevel as string } : {}),
              ...(rt.fastMode !== undefined ? { fastMode: rt.fastMode as boolean } : {}),
            },
          }
        : {}),
    };
  }
  const count = Object.keys(options).length;
  if (count < 2 || count > MAX_OPTIONS) return { error: `${r.id}: needs 2 to ${MAX_OPTIONS} options` };
  if (typeof r.onError !== "string" || !Object.hasOwn(options, r.onError))
    return { error: `${r.id}: onError must name one of its options` };
  const m = (r.model ?? {}) as Record<string, unknown>;
  if (typeof m.provider !== "string" || !providers.some((p) => p.id === m.provider))
    return { error: `${r.id}: model.provider must name a configured decision provider` };
  if (typeof m.model !== "string" || !m.model.trim()) return { error: `${r.id}: model.model is required` };
  return {
    rule: {
      id: r.id,
      hook: r.hook as DecisionHook,
      question: r.question,
      options,
      model: { provider: m.provider, model: m.model },
      mode: r.mode as DecisionRule["mode"],
      onError: r.onError,
    },
  };
}

export function checkRuleSet(all: readonly DecisionRule[]): string | undefined {
  const rules = all.filter((r) => r.mode !== "off");
  if (rules.length > MAX_RULES) return `at most ${MAX_RULES} active decision rules`;
  const confidentHook = rules.find(
    (r, i) =>
      r.mode === "enforce" &&
      DECISION_HOOK_POINTS[r.hook].decide === "most_confident" &&
      rules.some((o, j) => j < i && o.hook === r.hook && o.mode === "enforce"),
  );
  if (confidentHook)
    return `${confidentHook.id}: ${confidentHook.hook} allows one enforcing rule; set the others to observe`;
  const text = rules.reduce(
    (n, r) => n + r.question.length + Object.values(r.options).reduce((m, o) => m + o.description.length, 0),
    0,
  );
  if (text > MAX_RULE_TEXT_CHARS)
    return `active decision rules total ${text} characters of questions and options; at most ${MAX_RULE_TEXT_CHARS}`;
  return undefined;
}

export const decisionCatalog = () => ({
  hooks: LIVE_DECISION_HOOKS.map((id) => ({ id, actions: DECISION_HOOK_POINTS[id].actions })),
  protocols: DECISION_PROTOCOLS,
  modes: DECISION_MODES,
});

function pick(rule: DecisionRule, probabilities: Record<string, number>): string {
  let best = rule.onError;
  let bestP = -1;
  for (const [key, opt] of Object.entries(rule.options)) {
    const p = probabilities[key] ?? 0;
    const restrictive = rank(rule.hook, opt.action) > rank(rule.hook, rule.options[best]!.action);
    if (p > bestP || (p === bestP && restrictive)) {
      best = key;
      bestP = p;
    }
  }
  return best;
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  for (let e = error, depth = 0; e !== undefined && depth < 5; depth++) {
    parts.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join(" <- ").slice(0, 2_000);
}

function settle(rule: DecisionRule, answer: Record<string, number> | Error | undefined): DecisionResult {
  let error: string | undefined;
  if (answer instanceof Error) error = errorChain(answer);
  else if (!answer) error = "classifier returned no answer";
  const probabilities = answer && !(answer instanceof Error) ? answer : {};
  const option = error ? rule.onError : pick(rule, probabilities);
  const opt = rule.options[option]!;
  return {
    ruleId: rule.id,
    option,
    action: opt.action,
    ...(opt.message ? { message: opt.message } : {}),
    ...(opt.runtime ? { runtime: opt.runtime } : {}),
    probabilities,
    mode: rule.mode,
    ...(error ? { error } : {}),
  };
}

async function runGroup(
  rules: readonly DecisionRule[],
  state: string,
  backend: DecisionBackend,
  signal: AbortSignal,
): Promise<DecisionResult[]> {
  let answers: Record<string, Record<string, number> | Error>;
  try {
    answers = await backend.choose({
      questions: Object.fromEntries(
        rules.map((r) => [
          r.id,
          {
            question: r.question,
            options: Object.fromEntries(Object.entries(r.options).map(([k, o]) => [k, o.description])),
          },
        ]),
      ),
      state: state.slice(0, MAX_STATE_CHARS).toWellFormed(),
      model: rules[0]!.model,
      signal,
    });
  } catch (error) {
    return rules.map((r) => settle(r, asError(error)));
  }
  return rules.map((r) => settle(r, answers[r.id]));
}

export const asError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error(
        `non-Error failure: ${(() => {
          try {
            return JSON.stringify(error)?.slice(0, 500) ?? String(error);
          } catch {
            return String(error);
          }
        })()}`,
        { cause: error },
      );

export async function runHook(
  rules: readonly DecisionRule[],
  hook: DecisionHook,
  state: string,
  backend: DecisionBackend,
  signal: AbortSignal,
): Promise<{ decisive?: DecisionResult; results: DecisionResult[] }> {
  const groups = new Map<string, DecisionRule[]>();
  for (const rule of rules.filter((r) => r.hook === hook)) {
    const key = JSON.stringify([rule.model.provider, rule.model.model]);
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const results = (await Promise.all([...groups.values()].map((g) => runGroup(g, state, backend, signal)))).flat();
  const confident = DECISION_HOOK_POINTS[hook].decide === "most_confident";
  const weight = (r: DecisionResult) => {
    if (!confident) return rank(hook, r.action);
    return r.error ? -1 : (r.probabilities[r.option] ?? 0);
  };
  let decisive: DecisionResult | undefined;
  for (const result of results) {
    if (result.mode !== "enforce") continue;
    if (!decisive || weight(result) > weight(decisive)) decisive = result;
  }
  return { ...(decisive ? { decisive } : {}), results };
}
