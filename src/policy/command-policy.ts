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
    pattern: "\\bgit\\b[^\\n;&|]*\\spush\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S)",
    decision: "require_approval",
    reason: "force push",
  },
  { pattern: "\\bfind\\b[^\\n]*\\s-delete\\b", decision: "require_approval", reason: "find -delete" },
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

const MAX_DEPTH = 8;
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const SHELL_VALUE_OPTIONS = ["-O", "-o", "--rcfile", "--init-file"];
const SCRIPT_INTERPRETERS = new Set(["node", "perl", "ruby"]);
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
    "-R",
    "--chroot",
    "-t",
    "--type",
  ],
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

interface Executed {
  scripts: string[];
  code: string[];
}

export function scannableCommand(command: string): string {
  return scanLines(command, 0).join("\n");
}

function parse(command: string) {
  const tree = parser.parse(command);
  if (!tree) throw new Error("tree-sitter-bash produced no syntax tree");
  return tree;
}

function scanLines(command: string, depth: number): string[] {
  const tree = parse(command);
  try {
    const executed = depth < MAX_DEPTH ? executedPayloads(tree.rootNode) : { scripts: [], code: [] };
    return [
      ...(tree.rootNode.hasError ? [command] : []),
      render(tree.rootNode),
      ...executed.code,
      ...executed.scripts.flatMap((script) => scanLines(script, depth + 1)),
    ];
  } finally {
    tree.delete();
  }
}

function bareWord(value: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(value) ? value : undefined;
}

function unescapeDoubleQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const next = text.charAt(i + 1);
    if (text.charAt(i) !== "\\" || !'$`"\\\n'.includes(next)) out += text.charAt(i);
    else if (next !== "\n") out += text.charAt(++i);
    else i++;
  }
  return out;
}

function unescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charAt(text.charAt(i) === "\\" ? ++i : i);
  return out;
}

function sourceBetween(node: Node, from: number, to: number): string {
  return node.text.slice(from - node.startIndex, to - node.startIndex).replaceAll("\\\n", "");
}

function substitutions(node: Node): Node[] {
  return node.namedChildren.filter(
    (child): child is Node => child?.type === "command_substitution" || child?.type === "process_substitution",
  );
}

function render(node: Node): string {
  switch (node.type) {
    case "raw_string":
      return bareWord(node.text.slice(1, -1)) ?? "''";
    case "ansi_c_string":
      return bareWord(decodeAnsiC(node.text.slice(2, -1))) ?? "''";
    case "string": {
      const subs = substitutions(node);
      if (subs.length) return subs.map(render).join(" ");
      return bareWord(literal(node)) ?? '""';
    }
    case "word":
      return unescape(node.text);
    case "comment":
      return "";
    case "heredoc_body":
      return substitutions(node).map(render).join(" ");
  }
  let out = "";
  let at = node.startIndex;
  for (const child of node.children) {
    if (!child) continue;
    out += sourceBetween(node, at, child.startIndex) + render(child);
    at = child.endIndex;
  }
  return out + sourceBetween(node, at, node.endIndex);
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
        .map((child) => (child?.type === "string_content" ? unescapeDoubleQuoted(child.text) : (child?.text ?? "")))
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

function commandWords(command: Node): Node[][] {
  const name = command.childForFieldName("name");
  if (!name) return [];
  const words: Node[][] = [];
  for (const word of [name.firstNamedChild ?? name, ...command.childrenForFieldName("argument")]) {
    if (!word) continue;
    const group = words.at(-1);
    if (group && sourceBetween(command, group.at(-1)!.endIndex, word.startIndex) === "") group.push(word);
    else words.push([word]);
  }
  return words;
}

function argvOf(command: Node): string[] {
  return commandWords(command).map((group) => group.map(literal).join(""));
}

function basename(word: string): string {
  return word.split("/").pop() ?? word;
}

function skipOptions(args: string[], valueOptions: readonly string[]): number {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (valueOptions.includes(arg) && !arg.includes("=")) i++;
  }
  return i;
}

function envSplitPayload(argv: string[]): string | undefined {
  if (basename(argv[0] ?? "") !== "env") return undefined;
  const args = argv.slice(1);
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
    const split = envSplitPayload(argv);
    if (split !== undefined) return parsedWords(split);
    let next = skipOptions(args, ["-u", "--unset", "-C", "--chdir"]);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return args.slice(next);
  }
  if (executable === "command" || executable === "builtin") {
    const next = skipOptions(args, []);
    return args.slice(0, next).some((arg) => arg === "-v" || arg === "-V") ? undefined : args.slice(next);
  }
  if (executable === "timeout") return args.slice(skipOptions(args, ["-s", "--signal", "-k", "--kill-after"]) + 1);
  const options = WRAPPER_OPTIONS[executable];
  return options ? args.slice(skipOptions(args, options)) : undefined;
}

function wrapperChain(argv: string[]): string[][] {
  const chain = [argv];
  for (let inner = wrappedCommand(argv); inner?.length && chain.length < MAX_DEPTH; inner = wrappedCommand(inner))
    chain.push(inner);
  return chain;
}

function innermost(argv: string[]): string[] {
  return wrapperChain(argv).at(-1)!;
}

function parsedWords(text: string): string[] {
  const tree = parse(text);
  try {
    const command = tree.rootNode.descendantsOfType("command")[0];
    return command ? argvOf(command) : [];
  } finally {
    tree.delete();
  }
}

function shellInvocation(inner: string[]): { script?: string; readsStdin: boolean } | undefined {
  if (!SHELLS.has(basename(inner[0] ?? ""))) return undefined;
  const args = inner.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-s") return { readsStdin: true };
    if (arg === "--") return { readsStdin: args[i + 1] === undefined || STDIN_SCRIPTS.has(args[i + 1]!) };
    if (SHELL_VALUE_OPTIONS.includes(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") return { readsStdin: STDIN_SCRIPTS.has(arg) };
    else if (!arg.startsWith("--") && arg.includes("c")) return { script: args[i + 1], readsStdin: false };
  }
  return { readsStdin: true };
}

function stdinReader(argv: string[]): "shell" | "code" | undefined {
  const inner = innermost(argv);
  const executable = basename(inner[0] ?? "");
  if (shellInvocation(inner)?.readsStdin) return "shell";
  if (sqlClientSpec(inner) || SCRIPT_INTERPRETERS.has(executable) || executable.startsWith("python")) return "code";
  return undefined;
}

function shellPayloads(argv: string[]): string[] {
  const chain = wrapperChain(argv);
  const inner = chain.at(-1)!;
  const splits = chain.map(envSplitPayload).filter((split) => split !== undefined);
  const executable = basename(inner[0] ?? "");
  if (executable === "eval") return [...splits, ...(inner.length > 1 ? [inner.slice(1).join(" ")] : [])];
  const script = shellInvocation(inner)?.script;
  return [...splits, ...(script === undefined ? [] : [script])];
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

function heredocReceivers(statement: Node, redirect: Node): string[][] {
  const continuation = redirect.namedChildren.filter((child) => child?.type !== "heredoc_body");
  return [
    statement.childForFieldName("body"),
    ...continuation.flatMap((child) => child?.descendantsOfType("command") ?? []),
  ]
    .map(commandOf)
    .filter((command) => command !== undefined)
    .map(argvOf);
}

function executedPayloads(root: Node): Executed {
  const executed: Executed = { scripts: [], code: [] };
  const variables = new Map<string, string>();
  const feed = (text: string, readers: string[][]) => {
    const kinds = readers.map(stdinReader);
    if (kinds.includes("shell")) executed.scripts.push(text);
    else if (kinds.includes("code")) executed.code.push(text);
  };
  const visit = (node: Node) => {
    if (node.type === "variable_assignment") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      if (name && value && bareWord(literal(value))) variables.set(name, literal(value));
    }
    if (node.type === "command") {
      const words = commandWords(node);
      const argv = argvOf(node);
      executed.scripts.push(...shellPayloads(argv));
      executed.code.push(...sqlClientPayloads(innermost(argv)));
      const position = argv.length - innermost(argv).length;
      const word = words[position];
      const variable = word?.length === 1 ? variableName(word[0]!) : undefined;
      const value = variable === undefined ? undefined : variables.get(variable);
      if (value !== undefined)
        executed.scripts.push([...argv.slice(0, position), value, ...argv.slice(position + 1)].join(" "));
      const herestring = node.namedChildren.find((child) => child?.type === "herestring_redirect")?.lastNamedChild;
      if (herestring) feed(literal(herestring), [argv]);
    }
    for (const redirect of node.type === "redirected_statement" ? node.childrenForFieldName("redirect") : []) {
      const body = redirect?.namedChildren.find((child) => child?.type === "heredoc_body");
      if (body) feed(body.text, heredocReceivers(node, redirect!));
    }
    if (node.type === "pipeline") {
      const stages = node.namedChildren.map(commandOf);
      for (let i = 1; i < stages.length; i++) {
        const [producer, consumer] = [stages[i - 1], stages[i]];
        const payload = producer && consumer ? literalProducerPayload(argvOf(producer)) : undefined;
        if (payload) feed(payload, [argvOf(consumer!)]);
      }
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return executed;
}

function decodeAnsiC(value: string): string {
  const named: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return value.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g, (_, escape: string) => {
    const kind = escape.charAt(0);
    if ("xuU".includes(kind) && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if ("01234567".includes(kind)) return String.fromCodePoint(Number.parseInt(escape, 8));
    return named[escape] ?? ("\\'\"".includes(escape) ? escape : `\\${escape}`);
  });
}

const SQL_CLIENT_SPECS: Record<string, { options: string[]; sqlPositionalsAfter?: number }> = {
  psql: { options: ["-c", "--command"] },
  pgcli: { options: ["-c", "--command"] },
  mysql: { options: ["-e", "--execute"] },
  mariadb: { options: ["-e", "--execute"] },
  mycli: { options: ["-e", "--execute"] },
  sqlite3: { options: ["-cmd"], sqlPositionalsAfter: 1 },
  sqlcmd: { options: ["-Q", "-q"] },
  duckdb: { options: ["-c", "-s", "--command"], sqlPositionalsAfter: 1 },
  "clickhouse-client": { options: ["-q", "--query"] },
};

function sqlClientSpec(words: string[]): { options: string[]; sqlPositionalsAfter?: number } | undefined {
  return SQL_CLIENT_SPECS[basename(words[0] ?? "").toLowerCase()];
}

function sqlClientPayloads(words: string[]): string[] {
  const spec = sqlClientSpec(words);
  if (!spec) return [];
  const args = words.slice(1);
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
