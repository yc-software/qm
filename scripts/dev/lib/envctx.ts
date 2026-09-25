import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { liveEnvPath } from "./pool.ts";
import { bestEffort, readEnvFile, sha256Hex } from "./util.ts";
import { run } from "./proc.ts";
import { codexAuthFileForEnv, readCodexOAuthAuthFile } from "../../../src/harness/codex-auth-file.ts";

export interface AssembledEnv {
  env: Record<string, string>;
  anthropicKeySource: string;
  openaiKeySource: string;
  codexAuthSource: string;
  harness: "pi" | "mock" | "opencode" | "codex" | "claude";
  liveEnvFile: string;
  warnings: string[];
}

const DEV_SECURITY_SECRET_KEYS = [
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "CONNECTOR_SECRET_KEY",
  "PORTAL_SESSION_SECRET",
] as const;

export function completeDevSecuritySecrets(env: Record<string, string>, seed: string): void {
  for (const key of DEV_SECURITY_SECRET_KEYS) {
    if (!env[key]) env[key] = sha256Hex(`qm-dev\0${seed}\0${key}`);
  }
  const seen = new Set(DEV_SECURITY_SECRET_KEYS.map((key) => env[key]));
  if (seen.size !== DEV_SECURITY_SECRET_KEYS.length) {
    throw new Error(`${DEV_SECURITY_SECRET_KEYS.join(", ")} must be distinct`);
  }
}

export function repoRoot(cwd = process.cwd()): string {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error("not inside a git worktree");
  return res.stdout.trim();
}

export function currentBranch(cwd: string): string {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "?";
}

export function gitHead(cwd: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim().slice(0, 12) : "?";
}

function mainRepoRoot(worktree: string): string | null {
  const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return dirname(res.stdout.trim());
}

export function seedEnvFromMain(worktree: string, log: (msg: string) => void): void {
  const mainRoot = mainRepoRoot(worktree);
  if (!mainRoot || mainRoot === worktree) return;
  const mainEnv = join(mainRoot, ".env");
  if (!existsSync(mainEnv)) return;
  const wtEnvPath = join(worktree, ".env");
  const existing = readEnvFile(wtEnvPath);
  const main = readEnvFile(mainEnv);
  const added: string[] = [];
  for (const [k, v] of Object.entries(main)) {
    if (k in existing) continue;
    appendFileSync(wtEnvPath, `${k}=${v}\n`);
    added.push(k);
  }
  if (added.length) {
    bestEffort(() => chmodSync(wtEnvPath, 0o600));
    log(`seeded ${added.length} env key(s) for auth from the main checkout's .env: ${added.join(" ")}`);
  }
}

async function anthropicKeyFromLoginShell(): Promise<string> {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  const res = await run(shell, ["-lic", 'printf "__AKB__%s__AKE__" "${ANTHROPIC_API_KEY:-}"'], { timeoutMs: 15_000 });
  const out = res.stdout ?? "";
  const start = out.indexOf("__AKB__");
  const end = out.indexOf("__AKE__");
  if (start === -1 || end === -1 || end <= start) return "";
  return out.slice(start + 7, end);
}

export async function assembleEnv(opts: {
  worktree: string;
  callerEnv: Record<string, string>;
  allowMock: boolean;
  log: (msg: string) => void;
  probeLoginShell?: () => Promise<string>;
}): Promise<AssembledEnv> {
  const warnings: string[] = [];
  const liveEnvFile = liveEnvPath();
  const env: Record<string, string> = { ...opts.callerEnv };
  for (const [k, v] of Object.entries(readEnvFile(liveEnvFile))) {
    if (!env[k]) env[k] = v;
  }
  const wtEnv = readEnvFile(join(opts.worktree, ".env"));

  let anthropicKeySource = "";
  if (opts.callerEnv.ANTHROPIC_API_KEY) anthropicKeySource = "your shell export";
  else {
    const shellKey = await (opts.probeLoginShell ?? anthropicKeyFromLoginShell)();
    if (shellKey) {
      env.ANTHROPIC_API_KEY = shellKey;
      anthropicKeySource = "your login-shell profile";
    } else if (env.ANTHROPIC_API_KEY) {
      anthropicKeySource = liveEnvFile;
    }
  }
  if (!env.ANTHROPIC_API_KEY && wtEnv.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = wtEnv.ANTHROPIC_API_KEY;
    anthropicKeySource = "the worktree .env";
  }
  let openaiKeySource = "";
  if (opts.callerEnv.OPENAI_API_KEY) openaiKeySource = "your shell export";
  else if (env.OPENAI_API_KEY) openaiKeySource = liveEnvFile;
  if (!env.OPENAI_API_KEY && wtEnv.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = wtEnv.OPENAI_API_KEY;
    openaiKeySource = "the worktree .env";
  }

  if (!env.CODEX_AUTH_FILE && wtEnv.CODEX_AUTH_FILE) env.CODEX_AUTH_FILE = wtEnv.CODEX_AUTH_FILE;
  let codexAuthSource = "";
  const codexAuthCandidate = codexAuthFileForEnv({ ...env, ...opts.callerEnv }, true);
  const codexOAuthConfigured = Boolean(codexAuthCandidate && readCodexOAuthAuthFile(codexAuthCandidate));
  if (codexOAuthConfigured && codexAuthCandidate) {
    env.CODEX_AUTH_FILE = codexAuthCandidate;
    codexAuthSource = codexAuthCandidate;
  }

  let harness: "pi" | "mock" | "opencode" | "codex" | "claude";
  if (opts.callerEnv.HARNESS === "codex" || opts.callerEnv.HARNESS === "claude") {
    harness = opts.callerEnv.HARNESS;
    env.HARNESS = harness;
    if (harness === "codex" && !env.OPENAI_API_KEY && !codexOAuthConfigured) {
      throw new Error(
        "HARNESS=codex needs OPENAI_API_KEY or a readable ChatGPT OAuth auth.json via CODEX_AUTH_FILE (or ~/.codex/auth.json)",
      );
    }
  } else if (env.ANTHROPIC_API_KEY) {
    harness = opts.callerEnv.HARNESS === "opencode" ? "opencode" : "pi";
    env.HARNESS = harness;
    if (harness === "pi" && !env.PI_CAPTURE_REQUESTS) env.PI_CAPTURE_REQUESTS = "1";
  } else if (opts.allowMock) {
    harness = "mock";
    env.HARNESS = "mock";
    warnings.push("mock turns explicitly allowed by DEV_INSTANCE_ALLOW_MOCK=1 -- no anthropic key found");
  } else {
    throw new Error(
      `ANTHROPIC_API_KEY is required: dev instances exercise real LLM calls by default. Export a key, add one to ${liveEnvFile}, or set DEV_INSTANCE_ALLOW_MOCK=1 for a deliberate mock-only wiring check.`,
    );
  }

  for (const key of DEV_SECURITY_SECRET_KEYS) {
    if (!env[key] && wtEnv[key]) env[key] = wtEnv[key];
  }
  for (const k of ["SURFACE_DEBUG_FOOTER"]) {
    if (!env[k] && wtEnv[k]) env[k] = wtEnv[k];
  }

  return { env, anthropicKeySource, openaiKeySource, codexAuthSource, harness, liveEnvFile, warnings };
}

export function envFileGet(path: string, key: string): string {
  return readEnvFile(path)[key] ?? "";
}

export function callerEnvSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
