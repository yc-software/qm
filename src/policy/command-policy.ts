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

export function scannableCommand(command: string): string {
  return scannableCommandAtDepth(command, 0);
}

function scannableCommandAtDepth(command: string, depth: number): string {
  const stripped = stripWrittenHeredocs(command);
  const base = stripped
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
      const subs = m.match(/\$\([^)]*\)|`[^`]*`/g);
      if (subs) return subs.join(" ");
      return unquoteBareWord(m.slice(1, -1)) ?? '""';
    })
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => unquoteBareWord(decodeAnsiC(inner)) ?? "''")
    .replace(/'[^']*'/g, (m) => unquoteBareWord(m.slice(1, -1)) ?? "''")
    .replace(/\\([\w@%+=:,./-])/g, "$1");
  if (depth >= 8) return base;
  const executed = executedShellPayloads(stripped);
  if (!executed.length) return base;
  return [base, ...executed.map((payload) => scannableCommandAtDepth(payload, depth + 1))].join("\n");
}

function stripWrittenHeredocs(command: string): string {
  return command.replace(
    /^([^\n]*)<<-?\s*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$/gm,
    (full, pre, quote, _delim, post, body) => {
      if (heredocRunsInterpreter(pre + post)) return full;
      // The heredoc body is data (written to a file or fed to a non-interpreter
      // command like cat/gh/jq), not something the shell executes. Keep only
      // command substitutions, which DO execute when the delimiter is unquoted.
      if (quote) return "";
      const subs = (body as string).match(/\$\([^)]*\)|`[^`]*`/g);
      return subs ? subs.join(" ") : "";
    },
  );
}

function heredocRunsInterpreter(commandLine: string): boolean {
  if (heredocRunsShell(commandLine)) return true;
  // SQL clients and script interpreters execute their stdin, so a heredoc fed
  // to them must stay visible to the rules (e.g. destructive SQL via psql).
  return /(?:^|[|;&]\s*)(?:\S*\/)?(?:psql|mysql|mariadb|sqlite3?|sqlcmd|python\d?(?:\.\d+)?|node|perl|ruby)\b/.test(
    commandLine,
  );
}

function heredocRunsShell(commandLine: string): boolean {
  const shells = /(?:^|[|;&]\s*)(?:\S*\/)?(?:ba|da|k|z)?sh((?:\s+[^|;&]*)?)/g;
  return [...commandLine.matchAll(shells)].some((match) => !/(?:^|\s)-[^-\s]*c(?:\s|$)/.test(match[1] ?? ""));
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

function unquoteBareWord(inner: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(inner) ? inner : undefined;
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

interface ShellScan {
  commands: string[][];
  nested: string[];
}

function scanShell(input: string): ShellScan {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let i = 0;
  const flush = () => {
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const commandSubstitution = (start: number): { body: string; end: number } | undefined => {
    let depth = 1;
    let quote = "";
    for (let j = start + 2; j < input.length; j++) {
      const c = input.charAt(j);
      if (c === "\\") {
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = "";
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === "$" && input.charAt(j + 1) === "(") {
        depth++;
        j++;
      } else if (c === ")" && --depth === 0) {
        return { body: input.slice(start + 2, j), end: j + 1 };
      }
    }
    return undefined;
  };
  while (i < input.length) {
    if (/\s/.test(input.charAt(i))) {
      if (input.charAt(i) === "\n") flush();
      i++;
      continue;
    }
    if (input.charAt(i) === "#" && words.length === 0) {
      while (i < input.length && input.charAt(i) !== "\n") i++;
      continue;
    }
    if (";|&(){}".includes(input.charAt(i))) {
      flush();
      while (i < input.length && ";|&(){}".includes(input.charAt(i))) i++;
      continue;
    }
    let word = "";
    let wordStarted = false;
    while (
      i < input.length &&
      !/\s/.test(input.charAt(i)) &&
      (!";|&(){}".includes(input.charAt(i)) || (input.charAt(i) === "&" && /[<>]$/.test(word)))
    ) {
      const c = input.charAt(i);
      if (c === "\\") {
        if (input.charAt(i + 1) === "\n") i += 2;
        else if (i + 1 < input.length) {
          wordStarted = true;
          word += input.charAt(i + 1);
          i += 2;
        } else i++;
        continue;
      }
      if (c === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 1);
        if (end < 0) {
          word += input.slice(i + 1);
          i = input.length;
        } else {
          word += input.slice(i + 1, end);
          i = end + 1;
        }
        continue;
      }
      if (c === "$" && input.charAt(i + 1) === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 2);
        if (end < 0) {
          word += input.slice(i + 2);
          i = input.length;
        } else {
          word += decodeAnsiC(input.slice(i + 2, end));
          i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        wordStarted = true;
        i++;
        while (i < input.length && input.charAt(i) !== '"') {
          if (input.charAt(i) === "\\" && i + 1 < input.length) {
            word += input.charAt(i + 1);
            i += 2;
          } else if (input.charAt(i) === "$" && input.charAt(i + 1) === "(") {
            const sub = commandSubstitution(i);
            if (!sub) {
              word += input.charAt(i++);
            } else {
              nested.push(sub.body);
              i = sub.end;
            }
          } else if (input.charAt(i) === "`") {
            const end = input.indexOf("`", i + 1);
            if (end < 0) i++;
            else {
              nested.push(input.slice(i + 1, end));
              i = end + 1;
            }
          } else word += input.charAt(i++);
        }
        if (input.charAt(i) === '"') i++;
        continue;
      }
      if (c === "$" && input.charAt(i + 1) === "(") {
        wordStarted = true;
        const sub = commandSubstitution(i);
        if (!sub) word += input.charAt(i++);
        else {
          nested.push(sub.body);
          i = sub.end;
        }
        continue;
      }
      if (c === "`") {
        wordStarted = true;
        const end = input.indexOf("`", i + 1);
        if (end < 0) i++;
        else {
          nested.push(input.slice(i + 1, end));
          i = end + 1;
        }
        continue;
      }
      word += c;
      wordStarted = true;
      i++;
    }
    if (wordStarted) words.push(word);
  }
  flush();
  return { commands, nested };
}

function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(word) || /^(?:if|then|elif|else|while|until|do|!)$/.test(word)) i++;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&)$/.test(word)) i += 2;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&).+/.test(word)) i++;
    else break;
  }
  return i;
}

function optionCommand(words: string[], start: number, valueOptions: Set<string>): number {
  let i = start;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") return i + 1;
    if (!word.startsWith("-") || word === "-") return i;
    const name = word.replace(/=.*/, "");
    if (valueOptions.has(name) && !word.includes("=")) i++;
  }
  return i;
}

function splitStringPayload(args: string[], split: number): { value: string | undefined; rest: string[] } {
  const arg = args[split]!;
  const compact = arg.startsWith("-S") && arg.length > 2;
  let value = args[split + 1];
  if (arg.includes("=")) value = arg.slice(arg.indexOf("=") + 1);
  else if (compact) value = arg.slice(2);
  const rest = args.slice(split + (arg.includes("=") || compact ? 1 : 2));
  return { value, rest };
}

function envSplitWords(args: string[]): string[] | undefined {
  const split = args.findIndex(
    (arg) => arg === "-S" || arg.startsWith("-S") || arg === "--split-string" || arg.startsWith("--split-string="),
  );
  if (split < 0) return undefined;
  const { value, rest } = splitStringPayload(args, split);
  if (value === undefined) return [];
  return scanShell([value, ...rest].join(" ")).commands[0] ?? [];
}

function shellPipelines(input: string): string[][] {
  const pipelines: string[][] = [];
  let pipeline: string[] = [];
  let start = 0;
  let quote = "";
  const finishSegment = (end: number) => {
    const segment = input.slice(start, end).trim();
    if (segment) pipeline.push(segment);
  };
  const finishPipeline = (end: number) => {
    finishSegment(end);
    if (pipeline.length > 1) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if ((char === "|" || char === "&") && input.charAt(i + 1) === char) {
      finishPipeline(i);
      i++;
      start = i + 1;
      continue;
    }
    if (char === "|") {
      finishSegment(i);
      if (input.charAt(i + 1) === "&") i++;
      start = i + 1;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&") {
      finishPipeline(i);
      start = i + 1;
    }
  }
  finishPipeline(input.length);
  return pipelines;
}

function segmentConsumesShellStdin(words: string[]): boolean {
  const start = commandStart(words);
  if (start >= words.length) return false;
  const executableWord = words[start]!;
  const executable = executableWord.split("/").pop() ?? executableWord;
  const args = words.slice(start + 1);
  if (["bash", "sh", "dash", "zsh", "ksh"].includes(executable)) {
    const stdinScripts = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (/^-[^-]*c/.test(arg)) return false;
      if (arg === "-s") return true;
      if (["-O", "-o", "--rcfile", "--init-file"].includes(arg)) {
        i++;
        continue;
      }
      if (arg === "--") return args[i + 1] === undefined || stdinScripts.has(args[i + 1]!);
      if (!arg.startsWith("-") || arg === "-") return stdinScripts.has(arg);
    }
    return true;
  }
  if (executable === "env") {
    const split = envSplitWords(args);
    if (split) return segmentConsumesShellStdin(split);
    let next = optionCommand(args, 0, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return segmentConsumesShellStdin(args.slice(next));
  }
  if (executable === "command") return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set())));
  if (executable === "exec") return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set(["-a"]))));
  if (executable === "sudo") {
    const next = optionCommand(
      args,
      0,
      new Set([
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
      ]),
    );
    return segmentConsumesShellStdin(args.slice(next));
  }
  if (executable === "nice")
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set(["-n", "--adjustment"]))));
  if (executable === "timeout") {
    const duration = optionCommand(args, 0, new Set(["-s", "--signal", "-k", "--kill-after"]));
    return segmentConsumesShellStdin(args.slice(duration + 1));
  }
  if (executable === "time")
    return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set(["-o", "--output", "-f", "--format"]))));
  if (executable === "nohup") return segmentConsumesShellStdin(args.slice(optionCommand(args, 0, new Set())));
  if (executable === "stdbuf") {
    return segmentConsumesShellStdin(
      args.slice(optionCommand(args, 0, new Set(["-i", "--input", "-o", "--output", "-e", "--error"]))),
    );
  }
  return false;
}

function literalProducerPayload(words: string[]): string | undefined {
  const start = commandStart(words);
  if (start >= words.length) return undefined;
  const executableWord = words[start]!;
  const executable = executableWord.split("/").pop() ?? executableWord;
  let args = words.slice(start + 1);
  if (executable === "command") {
    let next = 0;
    for (; next < args.length; next++) {
      if (args[next] === "--") {
        next++;
        break;
      }
      if (args[next] === "-v" || args[next] === "-V") return undefined;
      if (args[next] !== "-p") break;
    }
    return literalProducerPayload(args.slice(next));
  }
  if (executable === "builtin") {
    if (args[0]?.startsWith("-") && args[0] !== "--") return undefined;
    return literalProducerPayload(args[0] === "--" ? args.slice(1) : args);
  }
  if (executable === "exec") return literalProducerPayload(args.slice(optionCommand(args, 0, new Set(["-a"]))));
  if (executable === "env") {
    const split = envSplitWords(args);
    if (split) return literalProducerPayload(split);
    let next = optionCommand(args, 0, new Set(["-u", "--unset", "-C", "--chdir"]));
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return literalProducerPayload(args.slice(next));
  }
  if (executable === "sudo") {
    const next = optionCommand(
      args,
      0,
      new Set([
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
      ]),
    );
    return literalProducerPayload(args.slice(next));
  }
  if (executable === "nice")
    return literalProducerPayload(args.slice(optionCommand(args, 0, new Set(["-n", "--adjustment"]))));
  if (executable === "timeout") {
    const duration = optionCommand(args, 0, new Set(["-s", "--signal", "-k", "--kill-after"]));
    return literalProducerPayload(args.slice(duration + 1));
  }
  if (executable === "time")
    return literalProducerPayload(args.slice(optionCommand(args, 0, new Set(["-o", "--output", "-f", "--format"]))));
  if (executable === "nohup") return literalProducerPayload(args.slice(optionCommand(args, 0, new Set())));
  if (executable === "stdbuf")
    return literalProducerPayload(
      args.slice(optionCommand(args, 0, new Set(["-i", "--input", "-o", "--output", "-e", "--error"]))),
    );
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

function pipedShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  for (const pipeline of shellPipelines(input)) {
    for (let i = 1; i < pipeline.length; i++) {
      const consumer = scanShell(pipeline[i]!).commands[0];
      if (!consumer || !segmentConsumesShellStdin(consumer)) continue;
      const producerCommands = scanShell(pipeline[i - 1]!).commands;
      const producer = producerCommands.at(-1);
      if (!producer) continue;
      const payload = literalProducerPayload(producer);
      if (payload) payloads.push(payload);
    }
  }
  return payloads;
}

function hereStringShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  let spaced = "";
  let quote = "";
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === "\\") {
      spaced += input.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      spaced += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      spaced += char;
      continue;
    }
    if (input.startsWith("<<<", i)) {
      spaced += " <<< ";
      i += 2;
      continue;
    }
    spaced += char;
  }
  for (const words of scanShell(spaced).commands) {
    const redirect = words.indexOf("<<<");
    if (redirect <= 0 || !segmentConsumesShellStdin(words.slice(0, redirect))) continue;
    const payload = words[redirect + 1];
    if (payload) payloads.push(payload);
  }
  return payloads;
}

function simpleVariablePayloads(input: string): string[] {
  const values = new Map<string, string>();
  const payloads: string[] = [];
  const executableIndex = (words: string[], offset = 0): number | undefined => {
    const start = commandStart(words);
    if (start >= words.length) return undefined;
    const executableWord = words[start]!;
    const executable = executableWord.split("/").pop() ?? executableWord;
    const args = words.slice(start + 1);
    let next: number | undefined;
    if (executable === "command" || executable === "nohup") next = optionCommand(args, 0, new Set());
    else if (executable === "exec") next = optionCommand(args, 0, new Set(["-a"]));
    else if (executable === "env") {
      next = optionCommand(args, 0, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
      while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    } else if (executable === "sudo") {
      next = optionCommand(
        args,
        0,
        new Set([
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
        ]),
      );
    } else if (executable === "nice") next = optionCommand(args, 0, new Set(["-n", "--adjustment"]));
    else if (executable === "timeout")
      next = optionCommand(args, 0, new Set(["-s", "--signal", "-k", "--kill-after"])) + 1;
    else if (executable === "time") next = optionCommand(args, 0, new Set(["-o", "--output", "-f", "--format"]));
    else if (executable === "stdbuf")
      next = optionCommand(args, 0, new Set(["-i", "--input", "-o", "--output", "-e", "--error"]));
    if (next === undefined) return offset + start;
    const nested = executableIndex(args.slice(next), offset + start + 1 + next);
    return nested;
  };
  for (const words of scanShell(input).commands) {
    const start = commandStart(words);
    if (start >= words.length) {
      for (const word of words) {
        const match = /^([A-Za-z_]\w*)=([\w./-]+)$/.exec(word);
        if (match) values.set(match[1]!, match[2]!);
      }
      continue;
    }
    const index = executableIndex(words);
    if (index === undefined) continue;
    const match = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(words[index]!);
    const value = values.get(match?.[1] ?? match?.[2] ?? "");
    if (value) payloads.push([...words.slice(0, index), value, ...words.slice(index + 1)].join(" "));
  }
  return payloads;
}

function segmentShellPayloads(words: string[]): string[] {
  const start = commandStart(words);
  if (start >= words.length) return [];
  const executableWord = words[start]!;
  const executable = executableWord.split("/").pop() ?? executableWord;
  const args = words.slice(start + 1);
  if (["bash", "sh", "dash", "zsh", "ksh"].includes(executable)) {
    for (let j = 0; j < args.length; j++) {
      if (args[j] === "--" || !args[j]!.startsWith("-")) return [];
      if (["-O", "-o", "--rcfile", "--init-file"].includes(args[j]!)) {
        j++;
        continue;
      }
      if (/^-[^-]*c/.test(args[j]!)) return args[j + 1] === undefined ? [] : [args[j + 1]!];
    }
    return [];
  }
  if (executable === "eval") return args.length ? [args.join(" ")] : [];
  if (executable === "env") {
    const split = args.findIndex(
      (arg) => arg === "-S" || arg.startsWith("-S") || arg === "--split-string" || arg.startsWith("--split-string="),
    );
    if (split >= 0) {
      const { value, rest } = splitStringPayload(args, split);
      return value === undefined ? [] : [[value, ...rest].join(" ")];
    }
    let next = optionCommand(args, 0, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return segmentShellPayloads(args.slice(next));
  }
  if (executable === "command") {
    let next = 0;
    for (; next < args.length; next++) {
      if (args[next] === "--") {
        next++;
        break;
      }
      if (args[next] === "-v" || args[next] === "-V") return [];
      if (args[next] !== "-p") break;
    }
    return segmentShellPayloads(args.slice(next));
  }
  if (executable === "exec") return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set(["-a"]))));
  if (executable === "sudo") {
    const next = optionCommand(
      args,
      0,
      new Set([
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
      ]),
    );
    return segmentShellPayloads(args.slice(next));
  }
  if (executable === "nice")
    return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set(["-n", "--adjustment"]))));
  if (executable === "timeout") {
    const duration = optionCommand(args, 0, new Set(["-s", "--signal", "-k", "--kill-after"]));
    return segmentShellPayloads(args.slice(duration + 1));
  }
  if (executable === "time")
    return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set(["-o", "--output", "-f", "--format"]))));
  if (executable === "nohup") return segmentShellPayloads(args.slice(optionCommand(args, 0, new Set())));
  if (executable === "coproc") return segmentShellPayloads(args);
  if (executable === "xargs") {
    const next = optionCommand(
      args,
      0,
      new Set([
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
      ]),
    );
    return segmentShellPayloads(args.slice(next));
  }
  return [];
}

function executedShellPayloads(input: string): string[] {
  const scan = scanShell(input);
  return [
    ...scan.nested,
    ...scan.commands.flatMap(segmentShellPayloads),
    ...pipedShellPayloads(input),
    ...hereStringShellPayloads(input),
    ...simpleVariablePayloads(input),
  ];
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
