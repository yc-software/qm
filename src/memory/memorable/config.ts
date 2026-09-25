import type { MemoryCapturePolicy } from "../provider-router.ts";

export interface MemorableMemoryProviderConfig {
  id: string;
  type: "memorable";
  /** Command and leading arguments used to run the Memorable CLI, e.g. ["memorable"] or ["node", "/opt/memorable/cli.js"]. */
  argv: string[];
  /** Allow-listed environment handed to the spawned CLI. Never the whole process environment. */
  env: NodeJS.ProcessEnv;
  injectTimeoutMs: number;
  recordTimeoutMs: number;
  /** Process environment values that must be redacted from anything relayed to the CLI. */
  redactValues: Record<string, string>;
  /** Capture policies a route may set for this provider. Procedures are only ever recorded automatically. */
  capturePolicies: ReadonlySet<MemoryCapturePolicy>;
}

/** Baseline environment every spawn gets; operators extend it per provider with `passEnv`. */
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "HOME",
  "MEMORABLE_BACKEND",
  "MEMORABLE_DB_URL",
  "MEMORABLE_API_URL",
  "MEMORABLE_API_KEY",
  "MEMORABLE_HOME",
] as const;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_INJECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECORD_TIMEOUT_MS = 120_000;

function childEnv(env: NodeJS.ProcessEnv, passEnv: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...passEnv]) if (env[name] !== undefined) out[name] = env[name];
  out.MEMORABLE_BACKEND = env.MEMORABLE_BACKEND?.trim() || "qm";
  // The CLI gets the connection string under its own name only; DATABASE_URL itself never crosses.
  if (!out.MEMORABLE_DB_URL && env.DATABASE_URL) out.MEMORABLE_DB_URL = env.DATABASE_URL;
  return out;
}

function stringValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

function timeout(value: unknown, at: string, fallback: number, max: number): number {
  const ms = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(ms) || Number(ms) <= 0 || Number(ms) > max)
    throw new Error(`${at} must be an integer from 1 to ${max}`);
  return Number(ms);
}

function argv(value: unknown, at: string): string[] {
  if (value === undefined) return ["memorable"];
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${at} must be a non-empty string or array`);
    return [value];
  }
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string" && v.length))
    throw new Error(`${at} must be a non-empty string or array of non-empty strings`);
  return value as string[];
}

function passEnv(value: unknown, at: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && ENV_NAME.test(v)))
    throw new Error(`${at} must be an array of environment variable names`);
  return value as string[];
}

/** Parses one `type: "memorable"` provider entry from MEMORY_PROVIDER_CONFIG. */
export function parseMemorableProvider(
  raw: Record<string, unknown>,
  id: string,
  env: NodeJS.ProcessEnv,
): MemorableMemoryProviderConfig {
  const at = `memory provider ${id}`;
  return {
    id,
    type: "memorable",
    argv: argv(raw.bin, `${at}.bin`),
    env: childEnv(env, passEnv(raw.passEnv, `${at}.passEnv`)),
    injectTimeoutMs: timeout(raw.injectTimeoutMs, `${at}.injectTimeoutMs`, DEFAULT_INJECT_TIMEOUT_MS, 60_000),
    recordTimeoutMs: timeout(raw.recordTimeoutMs, `${at}.recordTimeoutMs`, DEFAULT_RECORD_TIMEOUT_MS, 600_000),
    redactValues: stringValues(env),
    capturePolicies: new Set<MemoryCapturePolicy>(["off", "automatic"]),
  };
}
