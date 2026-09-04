import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, errMessage } from "./log.ts";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const failures = (await Promise.allSettled(tasks)).filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) throw new CliError(failures.map((f) => errMessage(f.reason)).join("\n\n"));
}

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const procOpts = (o: { cwd?: string; env?: NodeJS.ProcessEnv }) => ({
  ...(o.cwd ? { cwd: o.cwd } : {}),
  ...(o.env ? { env: o.env } : {}),
});

async function pollUntil(cond: () => boolean, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await sleep(1000);
  }
  return false;
}

export function capture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; allow?: RegExp } = {},
): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...procOpts(opts),
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (opts.allow?.test(out)) return out;
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${out || err.message}`, { cause: e });
  }
}

export function captureBoth(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    ...procOpts(opts),
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

export function runInherit(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  execFileSync(cmd, args, {
    stdio: "inherit",
    ...procOpts(opts),
  });
}

export function spawnBackground(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string },
): number {
  const fd = openSync(opts.logFile, "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    ...procOpts(opts),
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`failed to spawn ${cmd}`);
  return child.pid;
}

export function streamLabeled(
  procs: { label: string; command: string; args: string[] }[],
  emit: (paddedLabel: string, line: string) => void,
): Promise<void> {
  const width = Math.max(0, ...procs.map((p) => p.label.length));
  return new Promise((resolveAll) => {
    let pending = procs.length;
    if (pending === 0) return resolveAll();
    const done = (): void => {
      if (--pending === 0) resolveAll();
    };
    for (const { label, command, args } of procs) {
      const tag = label.padEnd(width);
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const sink = (): { push: (buf: Buffer) => void; flush: () => void } => {
        let carry = "";
        return {
          push(buf: Buffer): void {
            carry += buf.toString("utf8");
            const lines = carry.split("\n");
            carry = lines.pop() ?? "";
            for (const line of lines) emit(tag, line);
          },
          flush(): void {
            if (carry) emit(tag, carry);
            carry = "";
          },
        };
      };
      const out = sink();
      const err = sink();
      child.stdout?.on("data", (b: Buffer) => out.push(b));
      child.stderr?.on("data", (b: Buffer) => err.push(b));
      let ended = false;
      const finish = (): void => {
        if (ended) return;
        ended = true;
        out.flush();
        err.flush();
        done();
      };
      child.on("close", finish);
      child.on("error", finish);
    }
  });
}

const pidAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killTree(pid: number, sig: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, sig);
    } catch {
      void 0;
    }
  }
}

export async function stopPid(pid: number | undefined, graceSec = 5): Promise<void> {
  if (!pidAlive(pid)) return;
  killTree(pid!, "SIGTERM");
  if (await pollUntil(() => !pidAlive(pid), graceSec)) return;
  killTree(pid!, "SIGKILL");
}

export function waitForLog(file: string, pattern: RegExp, timeoutSec: number): Promise<boolean> {
  return pollUntil(() => {
    if (!existsSync(file)) return false;
    try {
      return pattern.test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  }, timeoutSec);
}

export const tailString = (s: string, lines: number): string => s.split("\n").slice(-lines).join("\n");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((element) => (element === undefined ? "null" : canonicalJson(element))).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function tail(file: string, lines = 20): string {
  if (!existsSync(file)) return "";
  return tailString(readFileSync(file, "utf8"), lines);
}

export const isEnvVarName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

export function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate);
}

export function isInvalidSecret(name: string, value: string | undefined): boolean {
  if (isMissingOrPlaceholder(value)) return true;
  const candidate = value!.trim();
  if (name === "ADMIN_GRANTS") {
    const entries = candidate
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return (
      entries.length === 0 ||
      !entries.every((entry) => {
        const separator = entry.lastIndexOf(":");
        return separator > 0 && entry.slice(separator + 1).trim() === "org_admin";
      })
    );
  }
  return (
    (name === "CONNECTOR_SECRET_KEY" || name === "CORE_SIGNING_SECRET" || name === "SKILL_SIGNING_SECRET") &&
    candidate.length < 32
  );
}

// One line of a dotenv file, following Node's --env-file semantics for the
// `export ` prefix and quoted values ('', "", ``: the quotes are stripped and
// \n expands to a newline inside double quotes). Two deliberate divergences
// from Node, both pinned by tests: a `#` inside an unquoted value is part of
// the value (tokens and URL fragments), and a quoted value ends on its own
// line (writeEnvValue never emits multi-line values).
function parseEnvLine(raw: string): [key: string, value: string] | undefined {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return undefined;
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
  const eq = line.indexOf("=");
  if (eq <= 0) return undefined;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = value.indexOf(quote, 1);
    if (end > 0) {
      value = value.slice(1, end);
      if (quote === '"') value = value.replaceAll("\\n", "\n");
    }
  }
  return [key, value];
}

export function readEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const entry = parseEnvLine(raw);
    if (entry && isEnvVarName(entry[0])) out.set(entry[0], entry[1]);
  }
  return out;
}

export function writeEnvValue(path: string, key: string, value: string): void {
  if (!isEnvVarName(key)) throw new CliError(`${JSON.stringify(key)} is not a valid environment variable name`);
  if (/[\r\n]/.test(value)) throw new CliError(`the value for ${key} must be a single line`);
  const existing = existsSync(path);
  const mode = existing ? statSync(path).mode & 0o777 : 0o600;
  const lines = existing ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const matches = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    const eq = trimmed.indexOf("=");
    return eq > 0 && trimmed.slice(0, eq).trim() === key;
  };
  const entry = `${key}=${value}`;
  const next: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (!matches(line)) {
      next.push(line);
    } else if (!placed) {
      next.push(entry);
      placed = true;
    }
  }
  if (!placed) next.push(entry);
  writeFileSync(path, `${next.join("\n")}\n`, { mode });
  chmodSync(path, mode);
}

export function deploymentSecretValue(name: string, fileValue: string | undefined): string | undefined {
  return fileValue === undefined || fileValue.trim() === "" ? process.env[name] : fileValue;
}

export function which(bin: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const flyBin = (): string => process.env.FLY_BIN ?? (which("flyctl") ? "flyctl" : "fly");

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();

export function gitTopLevel(): string {
  try {
    return git(["rev-parse", "--show-toplevel"]);
  } catch {
    throw new CliError("not inside a git worktree (run this from a QM checkout)");
  }
}

export function resolveBuildRepoRoot(explicit?: string, requiredServices: readonly string[] = ["core"]): string {
  let root: string;
  if (explicit !== undefined) root = resolve(explicit);
  else {
    try {
      root = gitTopLevel();
    } catch {
      throw new CliError(
        "--build-from requires running inside the QM source repo, or pass a path: --build-from <repo>",
      );
    }
  }
  const missing = requiredServices.filter((service) => !existsSync(join(root, "deploy", service, "Dockerfile")));
  if (missing.length) {
    const source = explicit === undefined ? root : explicit;
    throw new CliError(
      `--build-from ${source}: not a QM checkout (missing ${missing.map((service) => `deploy/${service}/Dockerfile`).join(", ")})`,
    );
  }
  return root;
}

export function promptHidden(name: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new CliError(`missing ${name} in .env; an interactive terminal is required to prompt`);
  }
  return new Promise((resolve, reject) => {
    const bytes: number[] = [];
    const stdin = process.stdin;
    const finish = (error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes).toString("utf8"));
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new CliError("secret entry cancelled"));
        if (byte === 4) return bytes.length ? finish() : finish(new CliError("secret entry cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) {
          let dropped = bytes.pop();
          while (dropped !== undefined && (dropped & 0b1100_0000) === 0b1000_0000) dropped = bytes.pop();
        } else bytes.push(byte);
      }
    };
    process.stdout.write(`${name}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
