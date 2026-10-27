const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const SHELL_VALUE_OPTIONS = ["-O", "-o", "--rcfile", "--init-file"];
const SCRIPT_INTERPRETERS = new Set(["node", "perl", "ruby"]);
const STDIN_SCRIPTS = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
const SSH_VALUE_OPTIONS = ["-p", "-l", "-i", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-E", "-b", "-c", "-m", "-O"];
const SCAN_LAUNCHERS = new Set([
  "docker",
  "docker-compose",
  "podman",
  "nerdctl",
  "kubectl",
  "unshare",
  "nsenter",
  "bwrap",
]);
const SCRIPT_OPTION_LAUNCHERS = new Set(["su", "runuser", "flock", "script", "nix-shell"]);
const WRAPPER_OPTIONS: Record<string, string[]> = {
  "!": [],
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
  doas: ["-u", "-C"],
  exec: ["-a"],
  pkexec: ["--user"],
  firejail: [],
  runuser: ["-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell"],
  parallel: ["-j", "--jobs", "-S", "--sshlogin", "--results", "--joblog", "-a", "--arg-file"],
  "systemd-run": [
    "-p",
    "--property",
    "-u",
    "--unit",
    "--description",
    "-E",
    "--setenv",
    "-M",
    "--machine",
    "-H",
    "--host",
    "--uid",
    "--gid",
    "--nice",
    "--working-directory",
    "--on-active",
    "--on-boot",
    "--on-calendar",
    "--timer-property",
  ],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid"],
  taskset: ["-c", "--cpu-list", "-p", "--pid"],
  time: ["-o", "--output", "-f", "--format"],
  nohup: [],
  setsid: [],
  busybox: [],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  strace: ["-o", "--output", "-e", "--trace", "-p", "--attach", "-s", "--string-limit", "-a", "-b", "-E", "--env"],
  unshare: ["--map-user", "--map-group", "--setgroups", "--propagation", "--wd", "--root", "-S", "-G"],
  nsenter: ["-t", "--target", "-S", "--setuid", "-G", "--setgid", "-w", "--wd", "-r", "--root"],
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
const POSITIONAL_WRAPPERS: Record<string, string[]> = {
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  chroot: ["--userspec", "--groups"],
  flock: ["-w", "--timeout", "-E", "--conflict-exit-code"],
};
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
const INLINE_CODE_OPTIONS: Record<string, string[]> = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};
const PAYLOAD_EXECUTABLES = new Set([
  ...SHELLS,
  ...SCRIPT_INTERPRETERS,
  ...Object.keys(SQL_CLIENT_SPECS),
  "rm",
  "git",
  "curl",
  "wget",
  "eval",
  "source",
  "su",
  "ssh",
  "find",
  "xargs",
  "env",
  "sudo",
]);

export interface Unwrapped {
  inner: string[];
  splits: string[];
}

export function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

export function isShell(argv: string[]): boolean {
  return SHELLS.has(basename(argv[0] ?? ""));
}

export function bareWord(value: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(value) ? value : undefined;
}

function shellQuote(word: string): string {
  return bareWord(word) && word !== "" ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function skipOptions(words: readonly string[], from: number, valueOptions: readonly string[]): number {
  let i = from;
  for (; i < words.length; i++) {
    const arg = words[i]!;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (valueOptions.includes(arg) && !arg.includes("=")) i++;
  }
  return i;
}

function envSplitPayload(words: readonly string[], from: number): string | undefined {
  if (basename(words[from] ?? "") !== "env") return undefined;
  for (let i = from + 1; i < words.length; i++) {
    const arg = words[i]!;
    if (!arg.startsWith("-S") && !arg.startsWith("--split-string")) continue;
    const attached = arg.startsWith("-S") ? 2 : arg.indexOf("=") + 1;
    const inline = attached > 0 && arg.length > attached ? arg.slice(attached) : undefined;
    const split = inline ?? words[i + 1] ?? "";
    const rest = words.slice(inline === undefined ? i + 2 : i + 1).map(shellQuote);
    return [split, ...rest].join(" ");
  }
  return undefined;
}

function stepInto(words: readonly string[], at: number, lastQuoted: number, parseWords: (text: string) => string[]) {
  const executable = basename(words[at] ?? "");
  if (executable === "env") {
    const split = envSplitPayload(words, at);
    if (split !== undefined) return { words: parseWords(split), at: 0, split };
    let next = skipOptions(words, at + 1, ["-u", "--unset", "-C", "--chdir"]);
    while (next < words.length && /^[A-Za-z_]\w*=/.test(words[next]!)) next++;
    return { words, at: next };
  }
  if (executable === "command" || executable === "builtin") {
    const next = skipOptions(words, at + 1, []);
    const inspects = words.slice(at + 1, next).some((arg) => arg === "-v" || arg === "-V");
    return inspects ? undefined : { words, at: next };
  }
  if (executable === "eval") return lastQuoted <= at ? { words, at: at + 1 } : undefined;
  if (executable === "taskset" && !(words[at + 1] ?? "-").startsWith("-")) return { words, at: at + 2 };
  if (SCRIPT_OPTION_LAUNCHERS.has(executable) && words.includes("-c", at + 1)) return undefined;
  const positional = POSITIONAL_WRAPPERS[executable];
  if (positional) return { words, at: skipOptions(words, at + 1, positional) + 1 };
  const options = WRAPPER_OPTIONS[executable];
  return options ? { words, at: skipOptions(words, at + 1, options) } : undefined;
}

export function unwrap(argv: string[], parseWords: (text: string) => string[]): Unwrapped {
  let words: readonly string[] = argv;
  let at = 0;
  let lastQuoted = words.findLastIndex((word) => bareWord(word) === undefined);
  const splits: string[] = [];
  for (;;) {
    const step = stepInto(words, at, lastQuoted, parseWords);
    if (!step || step.at >= step.words.length) break;
    if (step.split !== undefined) splits.push(step.split);
    if (step.words !== words) lastQuoted = step.words.findLastIndex((word) => bareWord(word) === undefined);
    words = step.words;
    at = step.at;
  }
  return { inner: at === 0 && words === argv ? argv : words.slice(at), splits };
}

function shellInvocation(inner: string[]): { script?: string; readsStdin: boolean } | undefined {
  if (!isShell(inner)) return undefined;
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

export function stdinReader(inner: string[]): "shell" | "sql" | "code" | undefined {
  const executable = basename(inner[0] ?? "");
  if (shellInvocation(inner)?.readsStdin) return "shell";
  if (sqlClientSpec(inner)) return "sql";
  if (SCRIPT_INTERPRETERS.has(executable) || executable.startsWith("python")) return "code";
  return undefined;
}

function optionValue(words: string[], from: number, options: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = from; i < words.length; i++) {
    const arg = words[i]!;
    const option = options.find((opt) => arg === opt || arg.startsWith(`${opt}=`));
    if (!option) continue;
    if (arg === option) {
      if (words[i + 1] !== undefined) values.push(words[++i]!);
    } else values.push(arg.slice(option.length + 1));
  }
  return values;
}

export function launcherScripts(inner: string[]): string[] {
  const executable = basename(inner[0] ?? "");
  if (executable === "eval") return inner.length > 1 ? [inner.slice(1).join(" ")] : [];
  if (executable === "ssh") {
    const command = skipOptions(inner, skipOptions(inner, 1, SSH_VALUE_OPTIONS) + 1, []);
    return inner.length > command ? [inner.slice(command).join(" ")] : [];
  }
  if (executable === "trap") {
    const handler = inner.find((arg, i) => i > 0 && !arg.startsWith("-"));
    return handler === undefined || handler === "" ? [] : [handler];
  }
  if (executable === "nix-shell") return optionValue(inner, 1, ["--run", "--command"]);
  if (executable === "watch") {
    const command = skipOptions(inner, 1, ["-n", "--interval"]);
    return inner.length > command ? [inner.slice(command).join(" ")] : [];
  }
  if (SCRIPT_OPTION_LAUNCHERS.has(executable)) return optionValue(inner, 1, ["-c", "--command"]);
  const script = shellInvocation(inner)?.script;
  return script === undefined ? [] : [script];
}

export function readsScriptFiles(inner: string[]): boolean {
  const executable = basename(inner[0] ?? "");
  return executable === "source" || executable === "." || isShell(inner);
}

export function findExecCommands(argv: string[]): string[][] {
  if (basename(argv[0] ?? "") !== "find") return [];
  const commands: string[][] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(argv[i]!)) continue;
    const start = i + 1;
    while (i + 1 < argv.length && argv[i + 1] !== ";" && argv[i + 1] !== "+") i++;
    if (i >= start) commands.push(argv.slice(start, i + 1));
  }
  return commands;
}

export function scannedOffsets(argv: string[]): number[] {
  if (!SCAN_LAUNCHERS.has(basename(argv[0] ?? ""))) return [];
  const separator = argv.indexOf("--");
  if (separator >= 0 && separator + 1 < argv.length) return [separator + 1];
  const offsets: number[] = [];
  for (let i = 1; i < argv.length; i++) {
    const name = basename(argv[i]!);
    if (PAYLOAD_EXECUTABLES.has(name) || name.startsWith("mkfs") || name.startsWith("python")) offsets.push(i);
  }
  return offsets;
}

export function producerOutput(inner: string[]): { output: string; leftover: string[] } | undefined {
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
    return { output: decodeEscapes ? decodeAnsiC(payload) : payload, leftover: [] };
  }
  if (executable !== "printf" || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const output = decodeAnsiC(format!).replace(/%([%sb])/g, (_match, conversion: string) => {
    if (conversion === "%") return "%";
    const value = values[valueIndex++] ?? "";
    return conversion === "b" ? decodeAnsiC(value) : value;
  });
  return { output, leftover: [...values.slice(valueIndex), args.join(" ")] };
}

export function decodeAnsiC(value: string): string {
  const named: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return value.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g, (_, escape: string) => {
    const kind = escape.charAt(0);
    if ("xuU".includes(kind) && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if ("01234567".includes(kind)) return String.fromCodePoint(Number.parseInt(escape, 8));
    return named[escape] ?? ("\\'\"".includes(escape) ? escape : `\\${escape}`);
  });
}

function sqlClientSpec(words: string[]): { options: string[]; sqlPositionalsAfter?: number } | undefined {
  return SQL_CLIENT_SPECS[basename(words[0] ?? "").toLowerCase()];
}

function shortOptionPayload(arg: string, opt: string): "next" | string | undefined {
  if (opt.length !== 2 || arg.startsWith("--") || !arg.startsWith("-")) return undefined;
  if (/^-[A-Za-z]+$/.test(arg) && arg.endsWith(opt[1]!)) return "next";
  if (arg.startsWith(opt) && arg.length > 2) return arg.slice(2);
  return undefined;
}

export function sqlClientPayloads(words: string[]): string[] {
  const spec = sqlClientSpec(words);
  if (!spec) return [];
  const args = words.slice(1);
  const payloads: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let matched = false;
    for (const opt of spec.options) {
      const short = shortOptionPayload(arg, opt);
      if (arg === opt || short === "next") {
        if (args[i + 1] !== undefined) payloads.push(args[++i]!);
      } else if (arg.startsWith(`${opt}=`)) payloads.push(arg.slice(opt.length + 1));
      else if (short !== undefined) payloads.push(short);
      else continue;
      matched = true;
      break;
    }
    if (!matched && !arg.startsWith("-")) positionals.push(arg);
  }
  if (spec.sqlPositionalsAfter !== undefined) payloads.push(...positionals.slice(spec.sqlPositionalsAfter));
  return payloads;
}

export function inlineCodePayloads(words: string[]): string[] {
  const executable = basename(words[0] ?? "");
  const options = INLINE_CODE_OPTIONS[executable.startsWith("python") ? "python" : executable];
  return options ? optionValue(words, 1, options) : [];
}
