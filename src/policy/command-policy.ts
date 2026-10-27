import type { CommandDecision, CommandPolicy, CommandRule } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { compileSafeRegex } from "../util/safe-regex.ts";
import { basename, isShell, skipOptions } from "./shell-launchers.ts";
import { parseShellCommand, type Invocation } from "./shell-parse.ts";

type Unit =
  | { kind: "invocation"; invocation: Invocation }
  | { kind: "code"; text: string; sql: boolean; speculative: boolean }
  | { kind: "pipeline"; stages: string[][] }
  | { kind: "function"; name: string }
  | { kind: "source"; text: string }
  | { kind: "unparsed"; text: string };

interface BuiltinRule extends CommandRule {
  matches(unit: Unit): string | undefined;
}

interface CompiledRule {
  rule: CommandRule;
  matches(unit: Unit): string | undefined;
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

const GIT_VALUE_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
const RANK: Record<CommandDecision, number> = { allow: 0, require_approval: 1, deny: 2 };

function flagsBeforeTerminator(args: string[]): string[] {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).filter((arg) => arg.startsWith("-") && arg !== "-");
}

function shortFlag(arg: string, letter: string): boolean {
  const cluster = /^-([a-z]*)/i.exec(arg)?.[1] ?? "";
  return !arg.startsWith("--") && cluster.toLowerCase().includes(letter);
}

function levels(invocation: Invocation): string[][] {
  return invocation.inner === invocation.argv ? [invocation.argv] : [invocation.argv, invocation.inner];
}

function recursiveDelete(invocation: Invocation): string | undefined {
  return levels(invocation)
    .find((argv) => {
      if (basename(argv[0] ?? "") !== "rm") return false;
      return flagsBeforeTerminator(argv.slice(1)).some((arg) => arg === "--recursive" || shortFlag(arg, "r"));
    })
    ?.join(" ");
}

function forcePush(invocation: Invocation): string | undefined {
  return levels(invocation)
    .find((argv) => {
      if (basename(argv[0] ?? "") !== "git") return false;
      const subcommand = skipOptions(argv, 1, GIT_VALUE_OPTIONS);
      if (argv[subcommand] !== "push") return false;
      return flagsBeforeTerminator(argv.slice(subcommand + 1)).some(
        (arg) => arg.startsWith("--force") || shortFlag(arg, "f"),
      );
    })
    ?.join(" ");
}

function destructiveSql(code: string): string | undefined {
  const tokens = code.toLowerCase().split(/\W+/);
  const at = tokens.findIndex((token, i) => (token === "drop" || token === "truncate") && tokens[i + 1] === "table");
  return at < 0 ? undefined : `${tokens[at]} table`;
}

function mkfs(invocation: Invocation): string | undefined {
  return levels(invocation)
    .map((argv) => basename(argv[0] ?? ""))
    .find((name) => /^mkfs(\.|$)/.test(name));
}

function pipeToShell(stages: string[][]): string | undefined {
  const producer = stages.findIndex((argv) => basename(argv[0] ?? "") === "curl");
  if (producer < 0) return undefined;
  const shell = stages.slice(producer + 1).find(isShell);
  return shell ? `${stages[producer]!.join(" ")} | ${shell.join(" ")}` : undefined;
}

const BUILTIN_RULES: BuiltinRule[] = [
  {
    pattern: "builtin:recursive-delete",
    decision: "require_approval",
    reason: "recursive delete",
    matches: (unit) => (unit.kind === "invocation" ? recursiveDelete(unit.invocation) : undefined),
  },
  {
    pattern: "builtin:force-push",
    decision: "require_approval",
    reason: "force push",
    matches: (unit) => (unit.kind === "invocation" ? forcePush(unit.invocation) : undefined),
  },
  {
    pattern: "builtin:destructive-sql",
    decision: "require_approval",
    reason: "destructive SQL",
    matches: (unit) => (unit.kind === "code" && unit.sql ? destructiveSql(unit.text) : undefined),
  },
  {
    pattern: "builtin:mkfs-or-fork-bomb",
    decision: "deny",
    reason: "destructive / fork bomb",
    matches: (unit) => {
      if (unit.kind === "function") return unit.name === ":" ? ":()" : undefined;
      return unit.kind === "invocation" ? mkfs(unit.invocation) : undefined;
    },
  },
  {
    pattern: "builtin:pipe-to-shell",
    decision: "require_approval",
    reason: "pipe-to-shell",
    matches: (unit) => (unit.kind === "pipeline" ? pipeToShell(unit.stages) : undefined),
  },
];

const BUILTIN_BY_PATTERN = new Map(BUILTIN_RULES.map((rule) => [rule.pattern, rule]));

export function defaultOrgPolicy(): CommandPolicy {
  return {
    mode: "denylist",
    rules: BUILTIN_RULES.map(({ pattern, decision, reason }) => ({ pattern, decision, reason })),
  };
}

export function composePolicy(orgFloor: CommandPolicy, scope?: CommandPolicy): CommandPolicy {
  if (!scope) return orgFloor;
  const mode = orgFloor.mode === "allowlist" ? "allowlist" : scope.mode;
  return {
    mode,
    rules: [...orgFloor.rules, ...scope.rules],
  };
}

export function parseCommandPolicy(input: unknown): { policy: CommandPolicy } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "command policy must be an object" };
  }
  const b = input as { mode?: unknown; rules?: unknown };
  if (b.mode !== "denylist" && b.mode !== "allowlist") {
    return { error: 'mode must be "denylist" or "allowlist"' };
  }
  if (!Array.isArray(b.rules)) return { error: "rules must be an array" };
  const rules: CommandRule[] = [];
  for (const [i, raw] of b.rules.entries()) {
    if (typeof raw !== "object" || raw === null) return { error: `rules[${i}] must be an object` };
    const r = raw as { pattern?: unknown; decision?: unknown; reason?: unknown };
    if (typeof r.pattern !== "string" || r.pattern.length === 0) {
      return { error: `rules[${i}].pattern must be a non-empty string` };
    }
    if (!BUILTIN_BY_PATTERN.has(r.pattern)) {
      try {
        compileSafeRegex(r.pattern, "i");
      } catch (e) {
        return { error: `rules[${i}].pattern is not a valid regex: ${errMessage(e)}` };
      }
    }
    if (r.decision !== "allow" && r.decision !== "deny" && r.decision !== "require_approval") {
      return { error: `rules[${i}].decision must be "allow", "deny", or "require_approval"` };
    }
    if (r.reason !== undefined && typeof r.reason !== "string") {
      return { error: `rules[${i}].reason must be a string` };
    }
    rules.push({ pattern: r.pattern, decision: r.decision, ...(r.reason !== undefined ? { reason: r.reason } : {}) });
  }
  return { policy: { mode: b.mode, rules } };
}

function unitText(unit: Unit): string | undefined {
  if (unit.kind === "invocation") return unit.invocation.text;
  if (unit.kind === "code") return unit.sql ? unit.text : undefined;
  return unit.kind === "source" || unit.kind === "unparsed" ? unit.text : undefined;
}

function compileRules(rules: readonly CommandRule[], origin: string): { compiled: CompiledRule[]; faults: string[] } {
  const compiled: CompiledRule[] = [];
  const faults: string[] = [];
  rules.forEach((rule, i) => {
    if (BUILTIN_BY_PATTERN.has(rule.pattern)) return;
    try {
      const re = compileSafeRegex(rule.pattern, "i");
      compiled.push({
        rule,
        matches: (unit) => {
          const text = unitText(unit);
          return text === undefined ? undefined : re.exec(text)?.[0];
        },
      });
    } catch (e) {
      faults.push(`${origin} rule ${i + 1} (${JSON.stringify(rule.pattern)}) is not a valid pattern: ${errMessage(e)}`);
    }
  });
  return { compiled, faults };
}

function speculative(unit: Unit): boolean {
  if (unit.kind === "invocation") return unit.invocation.speculative;
  return unit.kind === "code" ? unit.speculative : false;
}

function floorRules(policy: CommandPolicy): CompiledRule[] {
  return BUILTIN_RULES.map((builtin) => {
    const mentions = policy.rules.filter(
      (rule) => rule.pattern === builtin.pattern && rule.decision !== builtin.decision,
    );
    const strictest = mentions.reduce<CommandRule | undefined>(
      (best, rule) => (best === undefined || RANK[rule.decision] > RANK[best.decision] ? rule : best),
      undefined,
    );
    const rule: CommandRule = strictest
      ? { pattern: builtin.pattern, decision: strictest.decision, reason: strictest.reason ?? builtin.reason }
      : { pattern: builtin.pattern, decision: builtin.decision, reason: builtin.reason };
    return { rule, matches: builtin.matches };
  });
}

function unitsOf(command: string): { units: Unit[]; exhausted: boolean } {
  const parsed = parseShellCommand(command);
  const units: Unit[] = [];
  for (const invocation of parsed.invocations) units.push({ kind: "invocation", invocation });
  for (const payload of parsed.code) units.push({ kind: "code", ...payload });
  for (const stages of parsed.pipelines) units.push({ kind: "pipeline", stages });
  for (const name of parsed.functions) units.push({ kind: "function", name });
  for (const text of parsed.sources) units.push({ kind: "source", text });
  for (const text of parsed.unparsed) units.push({ kind: "unparsed", text });
  return { units, exhausted: parsed.exhausted };
}

function firstHit(rules: readonly CompiledRule[], unit: Unit): CommandEvaluation | undefined {
  for (const { rule, matches } of rules) {
    const matched = matches(unit);
    if (matched === undefined) continue;
    return {
      decision: rule.decision,
      ...(rule.reason ? { reason: rule.reason } : {}),
      matched,
      approvalKey: rule.pattern,
    };
  }
  return undefined;
}

function decideUnit(
  unit: Unit,
  policy: CommandPolicy,
  floor: readonly CompiledRule[],
  scope: readonly CompiledRule[],
  layer: readonly CompiledRule[],
): CommandEvaluation | undefined {
  if (speculative(unit)) {
    const restricting = [...scope, ...layer].filter((entry) => entry.rule.decision !== "allow");
    return firstHit([...floor, ...restricting], unit);
  }
  const own = firstHit([...floor, ...scope], unit);
  if (own) return own;
  if (policy.mode === "allowlist") {
    return unit.kind === "invocation" ? { decision: "deny", reason: "not in allowlist" } : undefined;
  }
  return firstHit(layer, unit);
}

function combined(result: CommandEvaluation, decisions: CommandEvaluation[]): CommandEvaluation {
  const keys = new Set<string>();
  for (const decision of decisions) {
    if (decision.decision !== result.decision || decision.approvalKey === undefined) continue;
    keys.add(decision.approvalKey);
  }
  if (keys.size < 2) return result;
  return { ...result, approvalKey: [...keys].sort().join(" + ") };
}

export function evaluateCommandWithLayer(
  command: string,
  policy: CommandPolicy,
  layerRules: readonly CommandRule[],
): CommandEvaluation {
  const scope = compileRules(policy.rules, "command policy");
  const layer = compileRules(layerRules, "deployment command");
  const floor = floorRules(policy);
  const { units, exhausted } = unitsOf(command);
  let result: CommandEvaluation = { decision: "allow" };
  const decisions: CommandEvaluation[] = [];
  for (const unit of units) {
    const decided = decideUnit(unit, policy, floor, scope.compiled, layer.compiled);
    if (!decided) continue;
    decisions.push(decided);
    if (RANK[decided.decision] > RANK[result.decision]) result = decided;
  }
  if (result.decision !== "allow") return combined(result, decisions);
  if (exhausted) return { decision: "require_approval", reason: "command is too complex to inspect fully" };
  const faults = [...scope.faults, ...layer.faults];
  if (faults.length) {
    return { decision: "require_approval", reason: `${faults.join("; ")}; re-save the policy to fix it` };
  }
  return result;
}

export function evaluateCommand(command: string, policy: CommandPolicy): CommandEvaluation {
  return evaluateCommandWithLayer(command, policy, []);
}
