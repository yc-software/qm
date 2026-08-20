import { posix } from "node:path";

const DIRECT_DEFAULT_TIMEOUT_MS = 600_000;
const DIRECT_DEFAULT_STDIN_MAX_BYTES = 1 * 1024 * 1024;
const DIRECT_DEFAULT_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const DIRECT_DEFAULT_STDERR_MAX_BYTES = 4 * 1024 * 1024;
const DIRECT_MAX_STDIN_BYTES = 16 * 1024 * 1024;
const DIRECT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DIRECT_RUNTIME_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DIRECT_DYNAMIC_ENV_KEYS = [
  "AGENT_API_URL",
  "AGENT_API_TOKEN",
  "AGENT_OAUTH_CONSENT_TOKEN",
  "AGENT_CREDENTIAL_TOKEN",
  "AGENT_OUTBOX",
] as const;

export interface ScopedCommand {
  argv: readonly string[];
  executablePath?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  allowedEnvKeys?: readonly string[];
  stdin?: string | Uint8Array;
}

export interface DirectExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  dynamicEnv?: Readonly<Record<string, string>>;
  allowedEnvKeys?: readonly string[];
  stdin?: string | Uint8Array;
  stdinMaxBytes?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

export interface DirectExecRequest {
  argv: string[];
  cwd: string;
  rootDir: string;
  env: Record<string, string>;
  allowedEnvKeys: string[];
  dynamicEnvKeys: string[];
  stdin?: Uint8Array;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
}

function invalid(label: string, detail: string): Error {
  return new Error(`${label} ${detail}`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.includes("\0")) throw invalid(label, "must be a NUL-free string");
}

function assertCanonicalExecutablePath(value: string, label = "executable path"): void {
  assertString(value, label);
  if (!value.startsWith("/")) throw invalid(label, "must be absolute");
  if (value === "/" || value.endsWith("/") || value.includes("\\")) {
    throw invalid(label, "must be a canonical absolute path");
  }
  const parts = value.split("/").slice(1);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw invalid(label, "must be a canonical absolute path");
  }
}

function assertConfinedPath(rootDir: string, requested: string, label: string): string {
  assertString(rootDir, "root directory");
  assertString(requested, label);
  if (!rootDir.startsWith("/") || rootDir.endsWith("/") || rootDir.includes("\0")) {
    throw invalid("root directory", "must be an absolute path");
  }
  const root = posix.normalize(rootDir);
  const candidate = requested.startsWith("/") ? posix.normalize(requested) : posix.join(root, requested);
  const relative = posix.relative(root, candidate);
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    throw invalid(label, "must stay inside the workspace root");
  }
  if (requested.split("/").some((part) => part === "..")) {
    throw invalid(label, "must not contain parent traversal");
  }
  return candidate;
}

function assertEnvKey(key: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw invalid(label, `contains an invalid key ${JSON.stringify(key)}`);
  if (/^AGENT_/i.test(key)) throw invalid(label, `contains a reserved key ${JSON.stringify(key)}`);
  if (key === "PATH") throw invalid(label, `contains a runtime-owned key ${JSON.stringify(key)}`);
}

function assertDynamicEnvKey(key: string, label: string): void {
  if (!(DIRECT_DYNAMIC_ENV_KEYS as readonly string[]).includes(key)) {
    throw invalid(label, `contains an unknown dynamic key ${JSON.stringify(key)}`);
  }
}

function boundedBytes(value: number | undefined, fallback: number, label: string, ceiling: number): number {
  const out = value ?? fallback;
  if (!Number.isSafeInteger(out) || out < 0 || out > ceiling)
    throw invalid(label, `must be an integer between 0 and ${ceiling}`);
  return out;
}

function bytes(value: string | Uint8Array | undefined, label: string, cap: number): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const out = typeof value === "string" ? Buffer.from(value, "utf8") : new Uint8Array(value);
  if (out.length > cap) throw invalid(label, `exceeds the ${cap}-byte limit`);
  return out;
}

function mergeEnv(
  command: ScopedCommand,
  opts: DirectExecOptions,
): { env: Record<string, string>; allowedEnvKeys: string[]; dynamicEnvKeys: string[] } {
  const raw = { ...command.env, ...opts.env };
  const dynamicEnv = opts.dynamicEnv ?? {};
  const dynamicEnvKeys = Object.keys(dynamicEnv);
  for (const key of dynamicEnvKeys) {
    assertDynamicEnvKey(key, "dynamic environment");
    assertString(dynamicEnv[key], `dynamic environment value ${key}`);
    if (key in raw) throw invalid("dynamic environment", `key ${JSON.stringify(key)} is also static`);
    raw[key] = dynamicEnv[key]!;
  }
  const allowed = opts.allowedEnvKeys ?? command.allowedEnvKeys ?? [];
  const allowedEnvKeys: string[] = [];
  if (allowed !== undefined) {
    const keys = new Set<string>();
    for (const key of allowed) {
      assertString(key, "environment allowlist key");
      assertEnvKey(key, "environment allowlist");
      if (keys.has(key)) throw invalid("environment allowlist", `contains a duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      allowedEnvKeys.push(key);
    }
    for (const key of Object.keys(raw)) {
      if (!dynamicEnvKeys.includes(key) && !keys.has(key)) {
        throw invalid("environment", `key ${JSON.stringify(key)} is not allowed`);
      }
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!dynamicEnvKeys.includes(key)) assertEnvKey(key, "environment");
    assertString(value, `environment value ${key}`);
  }
  return { env: raw, allowedEnvKeys, dynamicEnvKeys };
}

export function directRequest(
  rootDir: string,
  command: ScopedCommand,
  opts: DirectExecOptions = {},
): DirectExecRequest {
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    throw invalid("direct argv", "must contain an executable");
  }
  const argv = [...command.argv];
  for (const [index, arg] of argv.entries()) assertString(arg, `direct argv[${index}]`);
  const executable = command.executablePath ?? argv[0]!;
  assertCanonicalExecutablePath(executable);
  if (argv[0] !== executable) throw invalid("direct argv[0]", "must equal the descriptor-owned executable path");
  const cwd = assertConfinedPath(rootDir, opts.cwd ?? command.cwd ?? rootDir, "direct cwd");
  const timeoutMs = boundedBytes(opts.timeoutMs, DIRECT_DEFAULT_TIMEOUT_MS, "direct timeout", 24 * 60 * 60 * 1000);
  const stdinCap = boundedBytes(
    opts.stdinMaxBytes,
    DIRECT_DEFAULT_STDIN_MAX_BYTES,
    "direct stdin cap",
    DIRECT_MAX_STDIN_BYTES,
  );
  const stdoutMaxBytes = boundedBytes(
    opts.stdoutMaxBytes,
    DIRECT_DEFAULT_STDOUT_MAX_BYTES,
    "direct stdout cap",
    DIRECT_MAX_OUTPUT_BYTES,
  );
  const stderrMaxBytes = boundedBytes(
    opts.stderrMaxBytes,
    DIRECT_DEFAULT_STDERR_MAX_BYTES,
    "direct stderr cap",
    DIRECT_MAX_OUTPUT_BYTES,
  );
  const stdin = bytes(opts.stdin ?? command.stdin, "direct stdin", stdinCap);
  const merged = mergeEnv(command, opts);
  return {
    argv,
    cwd,
    rootDir: posix.normalize(rootDir),
    env: { PATH: DIRECT_RUNTIME_PATH, ...merged.env },
    allowedEnvKeys: merged.allowedEnvKeys,
    dynamicEnvKeys: merged.dynamicEnvKeys,
    ...(stdin ? { stdin } : {}),
    timeoutMs,
    stdoutMaxBytes,
    stderrMaxBytes,
  };
}
