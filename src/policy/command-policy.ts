import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { CommandDecision, CommandPolicy, CommandRule } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { compileSafeRegex } from "../util/safe-regex.ts";

const ORG_FLOOR_RULES: CommandRule[] = [
  {
    pattern: "\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)",
    decision: "require_approval",
    reason: "recursive delete",
  },
  {
    pattern: "\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)",
    decision: "require_approval",
    reason: "force push",
  },
  { pattern: "\\b(drop|truncate)\\s+table\\b", decision: "require_approval", reason: "destructive SQL" },
  { pattern: "\\bmkfs\\b|:\\(\\)\\s*\\{", decision: "deny", reason: "destructive / fork bomb" },
  { pattern: "\\bcurl\\b.*\\|\\s*(sh|bash)\\b", decision: "require_approval", reason: "pipe-to-shell" },
];

export function defaultOrgPolicy(): CommandPolicy {
  return { mode: "denylist", rules: ORG_FLOOR_RULES };
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
    try {
      compileSafeRegex(r.pattern, "i");
    } catch (e) {
      return { error: `rules[${i}].pattern is not a valid regex: ${errMessage(e)}` };
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

const require = createRequire(import.meta.url);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const INTERPRETERS = new Set(["psql", "mysql", "mariadb", "sqlite", "sqlite3", "sqlcmd", "node", "perl", "ruby"]);
const STDIN_SCRIPTS = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
const WRAPPER_OPTIONS: Record<string, string[]> = {
  sudo: [
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "--chdir",
    "-T",
    "--command-timeout",
  ].concat(["-R", "--chroot", "-t", "--type"]),
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  time: ["-o", "--output", "-f", "--format"],
  nohup: [],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  coproc: [],
  xargs: [
    "-a",
    "--arg-file",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
  ],
};

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

export function scannableCommand(command: string): string {
  return scanLines(command, 0).join("\n");
}

function scanLines(command: string, depth: number): string[] {
  const tree = parser.parse(command.replaceAll("\\\n", ""));
  if (!tree) return [command];
  try {
    const executed = new Set<number>();
    const payloads = depth < 8 ? executedPayloads(tree.rootNode, executed) : [];
    return [render(tree.rootNode, executed), ...payloads.flatMap((payload) => scanLines(payload, depth + 1))];
  } finally {
    tree.delete();
  }
}

function bareWord(value: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(value) ? value : undefined;
}

function unescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charAt(text.charAt(i) === "\\" ? ++i : i);
  return out;
}

function substitutions(node: Node): Node[] {
  return node.namedChildren.filter(
    (child): child is Node => child?.type === "command_substitution" || child?.type === "process_substitution",
  );
}

function render(node: Node, executed: Set<number>): string {
  switch (node.type) {
    case "raw_string":
      return bareWord(node.text.slice(1, -1)) ?? "''";
    case "ansi_c_string":
      return bareWord(decodeAnsiC(node.text.slice(2, -1))) ?? "''";
    case "string": {
      const subs = substitutions(node);
      if (subs.length) return subs.map((sub) => render(sub, executed)).join(" ");
      return bareWord(literal(node)) ?? '""';
    }
    case "word":
      return unescape(node.text);
    case "comment":
      return "";
    case "heredoc_body":
      return executed.has(node.id)
        ? node.text
        : substitutions(node)
            .map((sub) => render(sub, executed))
            .join(" ");
  }
  let out = "";
  let at = node.startIndex;
  for (const child of node.children) {
    if (!child) continue;
    out += node.text.slice(at - node.startIndex, child.startIndex - node.startIndex) + render(child, executed);
    at = child.endIndex;
  }
  return out + node.text.slice(at - node.startIndex);
}

function literal(node: Node): string {
  switch (node.type) {
    case "word":
      return unescape(node.text);
    case "raw_string":
      return node.text.slice(1, -1);
    case "ansi_c_string":
      return decodeAnsiC(node.text.slice(2, -1));
    case "string":
      return node.children
        .slice(1, -1)
        .map((child) => (child?.type === "string_content" ? unescape(child.text) : (child?.text ?? "")))
        .join("");
    case "concatenation":
      return node.children.map((child) => (child ? literal(child) : "")).join("");
  }
  return node.text;
}

function variableName(node: Node): string | undefined {
  const [only, ...rest] = node.namedChildren;
  if (!only || rest.length) return undefined;
  if (node.type === "string") return variableName(only);
  const expansion = node.type === "simple_expansion" || node.type === "expansion";
  return expansion && only.type === "variable_name" ? only.text : undefined;
}

function commandWords(command: Node): Node[] {
  const name = command.childForFieldName("name");
  const words = command.childrenForFieldName("argument").filter((word): word is Node => word !== null);
  return name ? [name.firstNamedChild ?? name, ...words] : [];
}

function basename(word: string): string {
  return word.split("/").pop() ?? word;
}

function skipOptions(args: string[], start: number, valueOptions: readonly string[]): number {
  let i = start;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (valueOptions.includes(arg.split("=")[0]!) && !arg.includes("=")) i++;
  }
  return i;
}

function envSplitPayload(args: string[]): string | undefined {
  const split = args.findIndex((arg) => arg.startsWith("-S") || arg.startsWith("--split-string"));
  if (split < 0) return undefined;
  const arg = args[split]!;
  if (arg.includes("=")) return [arg.slice(arg.indexOf("=") + 1), ...args.slice(split + 1)].join(" ");
  if (arg.startsWith("-S") && arg.length > 2) return [arg.slice(2), ...args.slice(split + 1)].join(" ");
  return args.slice(split + 1).join(" ");
}

function wrappedCommand(argv: string[]): string[] | undefined {
  const executable = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (executable === "env") {
    const split = envSplitPayload(args);
    if (split !== undefined) return parsedWords(split);
    let next = skipOptions(args, 0, ["-u", "--unset", "-C", "--chdir"]);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return args.slice(next);
  }
  if (executable === "command" || executable === "builtin") {
    if (args.some((arg, i) => i < skipOptions(args, 0, []) && (arg === "-v" || arg === "-V"))) return undefined;
    return args.slice(skipOptions(args, 0, []));
  }
  if (executable === "timeout") return args.slice(skipOptions(args, 0, ["-s", "--signal", "-k", "--kill-after"]) + 1);
  const options = WRAPPER_OPTIONS[executable];
  return options ? args.slice(skipOptions(args, 0, options)) : undefined;
}

function innermost(argv: string[]): string[] {
  for (let depth = 0; depth < 8; depth++) {
    const inner = wrappedCommand(argv);
    if (!inner?.length) return argv;
    argv = inner;
  }
  return argv;
}

function parsedWords(text: string): string[] {
  const tree = parser.parse(text);
  if (!tree) return [];
  try {
    const command = tree.rootNode.descendantsOfType("command")[0];
    return command ? commandWords(command).map(literal) : [];
  } finally {
    tree.delete();
  }
}

function shellCommandString(argv: string[]): string | undefined {
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" || !arg.startsWith("-")) return undefined;
    if (["-O", "-o", "--rcfile", "--init-file"].includes(arg)) i++;
    else if (!arg.startsWith("--") && arg.includes("c")) return args[i + 1];
  }
  return undefined;
}

function consumesShellStdin(argv: string[]): boolean {
  argv = innermost(argv);
  if (!SHELLS.has(basename(argv[0] ?? ""))) return false;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-s") return true;
    if (arg === "--") return args[i + 1] === undefined || STDIN_SCRIPTS.has(args[i + 1]!);
    if (["-O", "-o", "--rcfile", "--init-file"].includes(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") return STDIN_SCRIPTS.has(arg);
    else if (!arg.startsWith("--") && arg.includes("c")) return false;
  }
  return true;
}

function interpretsStdin(argv: string[]): boolean {
  const executable = basename(innermost(argv)[0] ?? "");
  return INTERPRETERS.has(executable) || executable.startsWith("python");
}

function shellPayloads(argv: string[]): string[] {
  const payloads: string[] = [];
  for (let wrapped: string[] | undefined = argv, depth = 0; wrapped?.length && depth < 8; depth++) {
    const split = basename(wrapped[0]!) === "env" ? envSplitPayload(wrapped.slice(1)) : undefined;
    if (split !== undefined) payloads.push(split);
    wrapped = wrappedCommand(wrapped);
  }
  return [...payloads, ...ownPayloads(innermost(argv))];
}

function ownPayloads(inner: string[]): string[] {
  const executable = basename(inner[0] ?? "");
  if (executable === "eval") return inner.length > 1 ? [inner.slice(1).join(" ")] : [];
  if (SHELLS.has(executable)) {
    const script = shellCommandString(inner);
    return script === undefined ? [] : [script];
  }
  return sqlClientPayloads(inner);
}

function literalProducerPayload(argv: string[]): string | undefined {
  const inner = innermost(argv);
  const executable = basename(inner[0] ?? "");
  let args = inner.slice(1);
  if (args[0] === "--") args = args.slice(1);
  if (executable === "echo") {
    let decodeEscapes = false;
    while (/^-[neE]+$/.test(args[0] ?? "")) {
      for (const option of args[0]!.slice(1)) {
        if (option === "e") decodeEscapes = true;
        if (option === "E") decodeEscapes = false;
      }
      args = args.slice(1);
    }
    const payload = args.join(" ");
    return decodeEscapes ? decodeAnsiC(payload) : payload;
  }
  if (executable !== "printf" || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const rendered = decodeAnsiC(format!).replace(/%([%sb])/g, (_match, conversion: string) => {
    if (conversion === "%") return "%";
    const value = values[valueIndex++] ?? "";
    return conversion === "b" ? decodeAnsiC(value) : value;
  });
  return [rendered, ...values.slice(valueIndex), args.join(" ")].join("\n");
}

function commandOf(node: Node | null): Node | undefined {
  if (node?.type === "command") return node;
  return node?.type === "redirected_statement" ? commandOf(node.childForFieldName("body")) : undefined;
}

function heredocReceivers(statement: Node, redirect: Node): Node[] {
  const continuation = redirect.namedChildren.filter((child) => child?.type !== "heredoc_body");
  return [
    statement.childForFieldName("body"),
    ...continuation.flatMap((child) => child?.descendantsOfType("command") ?? []),
  ]
    .map(commandOf)
    .filter((command) => command !== undefined);
}

function executedPayloads(root: Node, executed: Set<number>): string[] {
  const payloads: string[] = [];
  const variables = new Map<string, string>();
  const argvOf = (command: Node) => commandWords(command).map(literal);
  const visit = (node: Node) => {
    if (node.type === "variable_assignment") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      if (name && value && bareWord(literal(value))) variables.set(name, literal(value));
    }
    if (node.type === "command") {
      const words = commandWords(node);
      const argv = words.map(literal);
      payloads.push(...shellPayloads(argv));
      const inner = innermost(argv);
      const position = argv.length - inner.length;
      const variable = words[position] && variableName(words[position]);
      const value = variable === undefined ? undefined : variables.get(variable);
      if (value !== undefined)
        payloads.push([...argv.slice(0, position), value, ...argv.slice(position + 1)].join(" "));
      const herestring = node.namedChildren.find((child) => child?.type === "herestring_redirect");
      const herestringBody = herestring?.lastNamedChild;
      if (herestringBody && consumesShellStdin(argv)) payloads.push(literal(herestringBody));
    }
    for (const redirect of node.type === "redirected_statement" ? node.childrenForFieldName("redirect") : []) {
      const body = redirect?.namedChildren.find((child) => child?.type === "heredoc_body");
      if (!body) continue;
      const receivers = heredocReceivers(node, redirect!).map(argvOf);
      if (receivers.some(consumesShellStdin)) payloads.push(body.text);
      else if (receivers.some(interpretsStdin)) executed.add(body.id);
    }
    if (node.type === "pipeline") {
      const stages = node.namedChildren.map(commandOf);
      for (let i = 1; i < stages.length; i++) {
        const [producer, consumer] = [stages[i - 1], stages[i]];
        if (!producer || !consumer) continue;
        const argv = argvOf(consumer);
        if (!consumesShellStdin(argv) && !sqlClientSpec(argv)) continue;
        const payload = literalProducerPayload(argvOf(producer));
        if (payload) payloads.push(payload);
      }
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return payloads;
}

function decodeAnsiC(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)))
    .replace(
      /\\([\\'"abefnrtv])/g,
      (_, escape: string) =>
        ({ a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" })[escape] ?? escape,
    );
}

const SQL_CLIENT_SPECS: Record<string, { options: string[]; sqlPositionalsAfter?: number }> = {
  psql: { options: ["-c", "--command"] },
  pgcli: { options: ["-c", "--command"] },
  mysql: { options: ["-e", "--execute"] },
  mariadb: { options: ["-e", "--execute"] },
  mycli: { options: ["-e", "--execute"] },
  sqlite3: { options: ["-cmd"], sqlPositionalsAfter: 1 },
  duckdb: { options: ["-c", "-s", "--command"], sqlPositionalsAfter: 1 },
  "clickhouse-client": { options: ["-q", "--query"] },
};

function sqlClientSpec(
  words: string[],
): { spec: { options: string[]; sqlPositionalsAfter?: number }; args: string[] } | undefined {
  const spec = SQL_CLIENT_SPECS[basename(words[0] ?? "").toLowerCase()];
  return spec ? { spec, args: words.slice(1) } : undefined;
}

function sqlClientPayloads(words: string[]): string[] {
  const found = sqlClientSpec(words);
  if (!found) return [];
  const { spec, args } = found;
  const payloads: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let matched = false;
    for (const opt of spec.options) {
      if (arg === opt) {
        if (args[i + 1] !== undefined) payloads.push(args[++i]!);
        matched = true;
        break;
      }
      if (arg.startsWith(`${opt}=`)) {
        payloads.push(arg.slice(opt.length + 1));
        matched = true;
        break;
      }
      if (opt.length === 2 && !arg.startsWith("--") && arg.startsWith(opt) && arg.length > 2) {
        payloads.push(arg.slice(2));
        matched = true;
        break;
      }
    }
    if (!matched && !arg.startsWith("-")) positionals.push(arg);
  }
  if (spec.sqlPositionalsAfter !== undefined) payloads.push(...positionals.slice(spec.sqlPositionalsAfter));
  return payloads;
}

function firstMatch(scannable: string, rules: readonly CommandRule[]): CommandEvaluation | null {
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = compileSafeRegex(rule.pattern, "i");
    } catch {
      console.error(
        `[command-policy] skipping invalid stored rule pattern ${JSON.stringify(rule.pattern)} (${rule.decision}) — re-save it to migrate`,
      );
      continue;
    }
    const hit = re.exec(scannable);
    if (hit) {
      return {
        decision: rule.decision,
        ...(rule.reason ? { reason: rule.reason } : {}),
        matched: hit[0],
        approvalKey: rule.pattern,
      };
    }
  }
  return null;
}

export function evaluateCommand(command: string, policy: CommandPolicy): CommandEvaluation {
  const matched = firstMatch(scannableCommand(command), policy.rules);
  if (matched) return matched;
  if (policy.mode === "allowlist") {
    return { decision: "deny", reason: "not in allowlist" };
  }
  return { decision: "allow" };
}

export function evaluateCommandWithLayer(
  command: string,
  policy: CommandPolicy,
  layerRules: readonly CommandRule[],
): CommandEvaluation {
  const scannable = scannableCommand(command);
  const scopeMatch = firstMatch(scannable, policy.rules);
  if (scopeMatch) return scopeMatch;
  if (policy.mode === "allowlist") {
    return { decision: "deny", reason: "not in allowlist" };
  }
  const layerMatch = firstMatch(scannable, layerRules);
  if (layerMatch) return layerMatch;
  return { decision: "allow" };
}
