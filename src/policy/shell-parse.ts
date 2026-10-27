import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import {
  bareWord,
  decodeAnsiC,
  findExecCommands,
  inlineCodePayloads,
  launcherScripts,
  producerOutput,
  readsScriptFiles,
  scannedOffsets,
  sqlClientPayloads,
  stdinReader,
  unwrap,
} from "./shell-launchers.ts";

const require = createRequire(import.meta.url);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));

const OPAQUE_TYPES = ["raw_string", "string", "ansi_c_string", "heredoc_body", "comment"];
const DEFAULTING_EXPANSIONS = new Set(["-", ":-", "=", ":=", "+", ":+"]);
const BUDGET_FACTOR = 8;
const BUDGET_FLOOR = 8192;

export interface Invocation {
  text: string;
  argv: string[];
  inner: string[];
  speculative: boolean;
}

interface CodePayload {
  text: string;
  sql: boolean;
  speculative: boolean;
}

export interface ParsedCommand {
  invocations: Invocation[];
  pipelines: string[][][];
  code: CodePayload[];
  functions: string[];
  sources: string[];
  unparsed: string[];
  exhausted: boolean;
}

interface Collected extends ParsedCommand {
  scripts: string[];
}

interface Budget {
  left: number;
  exhausted: boolean;
}

interface Script {
  source: string;
  outputs: Map<number, string | undefined>;
  tails: Map<number, Node[]>;
}

function newScript(source: string): Script {
  return { source, outputs: new Map(), tails: new Map() };
}

export function parseShellCommand(command: string): ParsedCommand {
  const parsed: ParsedCommand = {
    invocations: [],
    pipelines: [],
    code: [],
    functions: [],
    sources: [],
    unparsed: [],
    exhausted: false,
  };
  const budget: Budget = { left: command.length * BUDGET_FACTOR + BUDGET_FLOOR, exhausted: false };
  const seen = new Set<string>();
  const pending = [{ text: command, speculative: false }];
  for (let next = 0; next < pending.length && !budget.exhausted; next++) {
    const { text: script, speculative } = pending[next]!;
    if (seen.has(script)) continue;
    seen.add(script);
    const collected = collect(script, speculative, budget);
    if (!collected) break;
    for (const key of ["invocations", "pipelines", "code", "functions"] as const) {
      for (const item of collected[key]) (parsed[key] as unknown[]).push(item);
    }
    if (!speculative) {
      parsed.sources.push(...collected.sources);
      parsed.unparsed.push(...collected.unparsed);
    }
    for (const text of collected.scripts) pending.push({ text, speculative });
    const opaque = [...collected.code.map((payload) => payload.text), ...collected.unparsed];
    for (const text of quotedLiterals(opaque, budget)) pending.push({ text, speculative: true });
  }
  parsed.exhausted = budget.exhausted;
  return parsed;
}

function quotedLiterals(texts: string[], budget: Budget): string[] {
  const literals: string[] = [];
  const queue = [...texts];
  for (let next = 0; next < queue.length; next++) {
    const code = queue[next]!;
    for (let i = 0; i < code.length; i++) {
      const quote = code.charAt(i);
      if (!"\"'`".includes(quote)) continue;
      let literal = "";
      let j = i + 1;
      for (; j < code.length && code.charAt(j) !== quote; j++) {
        if (code.charAt(j) === "\\" && quote !== "'") literal += decodeAnsiC(code.slice(j, ++j + 1));
        else literal += code.charAt(j);
      }
      if (j >= code.length) break;
      budget.left -= literal.length;
      if (budget.left < 0) {
        budget.exhausted = true;
        return literals;
      }
      literals.push(literal);
      queue.push(literal);
      i = j;
    }
  }
  return literals;
}

function parse(text: string, budget: Budget) {
  if (text.length > budget.left) {
    budget.exhausted = true;
    return undefined;
  }
  budget.left -= text.length;
  const tree = parser.parse(text);
  if (!tree) throw new Error("tree-sitter-bash produced no syntax tree");
  return tree;
}

function collect(script: string, speculative: boolean, budget: Budget): Collected | undefined {
  const tree = parse(script, budget);
  if (!tree) return undefined;
  try {
    const context = newScript(script);
    const substitutions = tree.rootNode.descendantsOfType(["command_substitution", "process_substitution"]);
    substitutions.sort((a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex));
    for (const node of substitutions) substitutionOutput(node, context);
    const collected = walk(tree.rootNode, context, speculative, budget);
    collected.sources.push(sourceText(script, tree.rootNode));
    if (tree.rootNode.hasError) collected.unparsed.push(script);
    return collected;
  } finally {
    tree.delete();
  }
}

function sourceText(script: string, root: Node): string {
  let out = "";
  let at = 0;
  for (const node of root.descendantsOfType(OPAQUE_TYPES)) {
    if (node.startIndex < at) continue;
    const replacement = opaqueRendering(node, newScript(script));
    if (replacement === undefined) continue;
    out += script.slice(at, node.startIndex) + replacement;
    at = node.endIndex;
  }
  return (out + script.slice(at)).replaceAll("\\\n", "");
}

function opaqueRendering(node: Node, script: Script): string | undefined {
  switch (node.type) {
    case "raw_string":
      return bareWord(node.text.slice(1, -1)) ?? "''";
    case "ansi_c_string":
      return bareWord(decodeAnsiC(node.text.slice(2, -1))) ?? "''";
    case "string":
      return node.namedChildren.some((child) => child?.type !== "string_content")
        ? undefined
        : (bareWord(literal(node, script)) ?? '""');
    default:
      return "";
  }
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
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "\\") out += text.charAt(i);
    else if (text.charAt(i + 1) !== "\n") out += text.charAt(++i);
    else i++;
  }
  return out;
}

function substitutionOutput(node: Node, script: Script): string | undefined {
  if (script.outputs.has(node.startIndex)) return script.outputs.get(node.startIndex);
  const [only, ...rest] = node.namedChildren;
  const command = only && !rest.length && only.type === "command" ? only : undefined;
  const output = command ? producerOutput(unwrap(argvOf(command, script), () => []).inner)?.output : undefined;
  script.outputs.set(node.startIndex, output);
  return output;
}

function render(node: Node, script: Script): string {
  switch (node.type) {
    case "word":
      return unescape(node.text);
    case "raw_string":
      return bareWord(node.text.slice(1, -1)) ?? "''";
    case "ansi_c_string":
      return bareWord(decodeAnsiC(node.text.slice(2, -1))) ?? "''";
    case "string":
      return bareWord(literal(node, script)) ?? '""';
    case "concatenation":
      return node.children.map((child) => (child ? render(child, script) : "")).join("");
    case "command_substitution":
      return substitutionOutput(node, script) ?? "$(...)";
    case "process_substitution":
      return "<(...)";
  }
  return node.text;
}

function stringLiteral(node: Node, script: Script): string {
  let out = "";
  let at = node.startIndex + 1;
  for (const child of node.children.slice(1, -1)) {
    if (!child) continue;
    out += unescapeDoubleQuoted(script.source.slice(at, child.startIndex));
    out += child.type === "string_content" ? unescapeDoubleQuoted(child.text) : literal(child, script);
    at = child.endIndex;
  }
  return out + unescapeDoubleQuoted(script.source.slice(at, node.endIndex - 1));
}

function literal(node: Node, script: Script): string {
  switch (node.type) {
    case "word":
      return unescape(node.text);
    case "raw_string":
      return node.text.slice(1, -1);
    case "ansi_c_string":
      return decodeAnsiC(node.text.slice(2, -1));
    case "string":
      return stringLiteral(node, script);
    case "concatenation":
      return node.children.map((child) => (child ? literal(child, script) : "")).join("");
    case "command_substitution":
      return substitutionOutput(node, script) ?? "$(...)";
    case "process_substitution":
      return "<(...)";
    case "expansion": {
      const operator = node.children.find((child) => child && DEFAULTING_EXPANSIONS.has(child.type));
      const fallback =
        operator && node.children.find((child) => child && child.startIndex >= operator.endIndex && child.type !== "}");
      return fallback ? literal(fallback, script) : node.text;
    }
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

function recordRedirectTail(statement: Node, script: Script): void {
  let body = statement.childForFieldName("body");
  while (body && (body.type === "pipeline" || body.type === "list")) body = body.lastNamedChild;
  if (body?.type !== "command") return;
  const tail: Node[] = [];
  for (const redirect of statement.childrenForFieldName("redirect")) {
    if (redirect?.type !== "file_redirect" && redirect?.type !== "heredoc_redirect") continue;
    const operands = redirect.namedChildren.filter(
      (child): child is Node =>
        !!child &&
        child.type !== "file_descriptor" &&
        !child.type.startsWith("heredoc_") &&
        !child.type.endsWith("_redirect"),
    );
    tail.push(...operands.slice(redirect.type === "file_redirect" ? 1 : 0));
  }
  if (tail.length) script.tails.set(body.startIndex, tail);
}

function commandWords(command: Node, script: Script): Node[][] {
  const name = command.childForFieldName("name");
  if (!name) return [];
  const words: Node[][] = [];
  const tail = script.tails.get(command.startIndex) ?? [];
  for (const word of [name.firstNamedChild ?? name, ...command.childrenForFieldName("argument"), ...tail]) {
    if (!word) continue;
    const group = words.at(-1);
    const gap = group ? script.source.slice(group.at(-1)!.endIndex, word.startIndex) : undefined;
    if (group && gap?.replaceAll("\\\n", "") === "") group.push(word);
    else words.push([word]);
  }
  return words;
}

function substitutionGroup(group: Node[]): "quoted" | "unquoted" | undefined {
  const [only, ...rest] = group;
  if (!only || rest.length) return undefined;
  if (only.type === "command_substitution") return "unquoted";
  const quoted = only.type === "string" && only.namedChildren.length === 1;
  return quoted && only.firstNamedChild?.type === "command_substitution" ? "quoted" : undefined;
}

function split(value: string): string[] {
  return value.split(/\s+/).filter((word) => word !== "");
}

function wordsOf(group: Node[], script: Script, position: number, resolved?: string): string[] {
  const quoted = group.length === 1 && group[0]!.type === "string";
  if (resolved !== undefined) return quoted && position > 0 ? [resolved] : split(resolved);
  const joined = group.map((word) => literal(word, script)).join("");
  const kind = substitutionGroup(group);
  const splits = kind === "unquoted" || (kind === "quoted" && position === 0);
  return splits && joined !== "$(...)" ? split(joined) : [joined];
}

function argvOf(command: Node, script: Script): string[] {
  return commandWords(command, script).flatMap((group, position) => wordsOf(group, script, position));
}

function commandOf(node: Node | null): Node | undefined {
  if (node?.type === "command") return node;
  return node?.type === "redirected_statement" ? commandOf(node.childForFieldName("body")) : undefined;
}

function redirectReceivers(statement: Node, redirect: Node): Node[] {
  const continuation = redirect.namedChildren.filter((child) => child?.type !== "heredoc_body");
  return [
    statement.childForFieldName("body"),
    ...continuation.flatMap((child) => child?.descendantsOfType("command") ?? []),
  ]
    .map(commandOf)
    .filter((command) => command !== undefined);
}

function pipelineStages(pipeline: Node, argv: (command: Node) => string[]): string[][] {
  return pipeline.namedChildren.flatMap((stage) => {
    if (!stage) return [];
    const command = commandOf(stage);
    return [
      ...(command ? [command] : []),
      ...stage.descendantsOfType("command").filter((node) => node.id !== command?.id),
    ].map(argv);
  });
}

function walk(root: Node, script: Script, speculative: boolean, budget: Budget): Collected {
  const collected: Collected = {
    invocations: [],
    pipelines: [],
    code: [],
    functions: [],
    sources: [],
    unparsed: [],
    scripts: [],
    exhausted: false,
  };
  const variables = new Map<string, string>();
  const parseWords = (text: string) => parsedWords(text, budget);
  const resolve = (group: Node[]): string | undefined => {
    const name = group.length === 1 ? variableName(group[0]!) : undefined;
    return name === undefined ? undefined : variables.get(name);
  };
  const argvOfWords = (words: Node[][]) =>
    words.flatMap((group, position) => wordsOf(group, script, position, resolve(group)));
  const argv = (command: Node) => argvOfWords(commandWords(command, script));
  const textOfWords = (words: Node[][]) =>
    words.map((group) => resolve(group) ?? group.map((word) => render(word, script)).join("")).join(" ");
  const invoke = (words: string[], unitText: string) => {
    const unwrapped = unwrap(words, parseWords);
    collected.invocations.push({ text: unitText, argv: words, inner: unwrapped.inner, speculative });
    for (const split of unwrapped.splits) collected.scripts.push(split);
    return unwrapped.inner;
  };
  const feed = (payload: string, readers: Node[]) => {
    const kinds = readers.map((reader) => stdinReader(unwrap(argv(reader), parseWords).inner));
    if (kinds.includes("shell")) collected.scripts.push(payload);
    else if (kinds.includes("sql")) collected.code.push({ text: payload, sql: true, speculative });
    else if (kinds.includes("code")) collected.code.push({ text: payload, sql: false, speculative });
  };
  const execute = (words: string[], unitText: string) => {
    const inner = invoke(words, unitText);
    for (const payload of launcherScripts(inner)) collected.scripts.push(payload);
    for (const sql of sqlClientPayloads(inner)) collected.code.push({ text: sql, sql: true, speculative });
    for (const code of inlineCodePayloads(inner)) collected.code.push({ text: code, sql: false, speculative });
    return inner;
  };
  const visitCommand = (node: Node, children: Node[]) => {
    const words = commandWords(node, script);
    const inner = execute(argvOfWords(words), textOfWords(words));
    for (const command of findExecCommands(inner)) execute(command, command.join(" "));
    const suffixCost = new Array<number>(inner.length + 1).fill(0);
    for (let i = inner.length - 1; i >= 0; i--) suffixCost[i] = suffixCost[i + 1]! + inner[i]!.length + 1;
    for (const offset of scannedOffsets(inner)) {
      budget.left -= suffixCost[offset]!;
      if (budget.left < 0) {
        budget.exhausted = true;
        break;
      }
      const command = inner.slice(offset);
      execute(command, command.join(" "));
    }
    if (readsScriptFiles(inner)) {
      for (const word of words.flat()) {
        const output = word.type === "process_substitution" ? substitutionOutput(word, script) : undefined;
        if (output !== undefined) collected.scripts.push(output);
      }
    }
    const herestring = children.find((child) => child.type === "herestring_redirect")?.lastNamedChild;
    if (herestring) feed(literal(herestring, script), [node]);
  };
  const visitRedirects = (node: Node) => {
    for (const redirect of node.childrenForFieldName("redirect")) {
      if (!redirect) continue;
      const body = redirect.namedChildren.find((child) => child?.type === "heredoc_body");
      if (body) feed(body.text, redirectReceivers(node, redirect));
      const process = redirect.namedChildren.find((child) => child?.type === "process_substitution");
      const output =
        process && redirect.children.some((child) => child?.type === "<")
          ? substitutionOutput(process, script)
          : undefined;
      if (output !== undefined) feed(output, redirectReceivers(node, redirect));
    }
  };
  const visitPipeline = (node: Node) => {
    collected.pipelines.push(pipelineStages(node, (command) => unwrap(argv(command), parseWords).inner));
    const stages = node.namedChildren.map(commandOf);
    for (let i = 1; i < stages.length; i++) {
      const [producer, consumer] = [stages[i - 1], stages[i]];
      const produced = producer && consumer ? producerOutput(unwrap(argv(producer), parseWords).inner) : undefined;
      if (produced) feed([produced.output, ...produced.leftover].join("\n"), [consumer!]);
    }
  };
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const children = node.namedChildren.filter((child): child is Node => child !== null);
    if (node.type === "variable_assignment") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      const assigned = value ? literal(value, script) : undefined;
      if (name && assigned !== undefined && !assigned.includes("$(...)")) variables.set(name, assigned);
    } else if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) collected.functions.push(name);
    } else if (node.type === "command") visitCommand(node, children);
    else if (node.type === "redirected_statement") {
      recordRedirectTail(node, script);
      visitRedirects(node);
    } else if (node.type === "pipeline") visitPipeline(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return collected;
}

function parsedWords(text: string, budget: Budget): string[] {
  const tree = parse(text, budget);
  if (!tree) return [];
  try {
    const command = tree.rootNode.descendantsOfType("command")[0];
    return command ? argvOf(command, newScript(text)) : [];
  } finally {
    tree.delete();
  }
}
