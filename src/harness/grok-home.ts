import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GROK_VERSION } from "../grok-build.ts";
import { startGrokProcess, type GrokProcessOptions } from "./grok-process.ts";

export { GROK_VERSION };
const GROK_BINARY_SHA256: Readonly<Record<string, string>> = {
  x64: "edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1",
  arm64: "b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25",
};
export const DEFAULT_GROK_BINARY = "/usr/local/bin/grok";

const SAFE_ENV_KEYS = ["LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;
const TURN_PREFIX = "qm-grok-";

export interface GrokTurnHome {
  root: string;
  workspace: string;
  grokHome: string;
  processHome: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export interface GrokRuntimeVerificationOptions {
  expectedVersion?: string;
  expectedSha256?: string;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function tomlLiteral(value: string): string {
  return JSON.stringify(value);
}

export function grokChildEnv(
  source: NodeJS.ProcessEnv,
  paths: Pick<GrokTurnHome, "root" | "grokHome" | "processHome">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  if (source.HTTPS_PROXY !== undefined) env.HTTPS_PROXY = source.HTTPS_PROXY;
  return {
    ...env,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: paths.processHome,
    GROK_HOME: paths.grokHome,
    TMPDIR: paths.root,
    NO_PROXY: "127.0.0.1,localhost",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_TELEMETRY_TRACE_UPLOAD: "0",
    GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
    GROK_EXTERNAL_OTEL: "0",
    GROK_SUBAGENTS: "0",
    GROK_WORKFLOWS: "0",
    GROK_GOAL: "0",
  };
}

export function sha256FileSync(path: string): string {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function resolveGrokBinary(path = DEFAULT_GROK_BINARY): string {
  const resolved = realpathSync(path);
  const info = statSync(resolved);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error("Grok binary is not an executable regular file");
  return resolved;
}

export function verifyGrokRuntime(
  path = DEFAULT_GROK_BINARY,
  options: GrokRuntimeVerificationOptions = {},
  source: NodeJS.ProcessEnv = {},
  launcherPath?: string,
): string {
  const binary = resolveGrokBinary(path);
  const expectedSha256 = options.expectedSha256 ?? GROK_BINARY_SHA256[process.arch];
  if (!expectedSha256) throw new Error(`Grok runtime is unsupported on ${process.arch}`);
  if (sha256FileSync(binary) !== expectedSha256)
    throw new Error("Grok binary digest does not match the verified release");
  const root = mkdtempSync(join(tmpdir(), "qm-grok-inspect-"));
  chmodSync(root, 0o700);
  const grokHome = join(root, "grok-home");
  const processHome = join(root, "home");
  const workspace = join(root, "workspace");
  for (const directory of [grokHome, processHome, workspace]) mkdirSync(directory, { mode: 0o700 });
  try {
    const launcher = launcherPath ? resolveGrokBinary(launcherPath) : binary;
    const result = spawnSync(launcher, [...(launcherPath ? [binary] : []), "inspect", "--json"], {
      cwd: workspace,
      env: grokChildEnv(source, { root, grokHome, processHome }),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || result.signal || result.stderr.trim())
      throw new Error("Grok runtime inspection failed");
    const inspection = JSON.parse(result.stdout) as {
      grokVersion?: unknown;
      warnings?: unknown;
      configSources?: { layers?: unknown };
    };
    if (inspection.grokVersion !== (options.expectedVersion ?? GROK_VERSION))
      throw new Error("Grok runtime version does not match the verified release");
    if (inspection.warnings !== undefined && (!Array.isArray(inspection.warnings) || inspection.warnings.length !== 0))
      throw new Error("Grok runtime inspection reported warnings");
    const layers = Array.isArray(inspection.configSources?.layers) ? inspection.configSources.layers : [];
    const pinned = layers.some(
      (layer) =>
        layer !== null &&
        typeof layer === "object" &&
        (layer as Record<string, unknown>).role === "system-requirements" &&
        (layer as Record<string, unknown>).path === "/etc/grok/requirements.toml",
    );
    if (!pinned) throw new Error("Grok system requirements are not active");
    return binary;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Grok ")) throw error;
    throw new Error("Grok runtime inspection failed", { cause: error });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function scavengeGrokHomes(parent = tmpdir(), uid = process.getuid?.()): string[] {
  if (uid === undefined) return [];
  const removed: string[] = [];
  for (const name of readdirSync(parent)) {
    const match = /^qm-grok-(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!match) continue;
    const path = join(parent, name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    const pid = Number(match[1]);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0 || pidAlive(pid)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export function createGrokTurnHome(model: string, source: NodeJS.ProcessEnv = {}): GrokTurnHome {
  const root = mkdtempSync(join(tmpdir(), `${TURN_PREFIX}${process.pid}-`));
  try {
    chmodSync(root, 0o700);
    const workspace = join(root, "workspace");
    const grokHome = join(root, "grok-home");
    const processHome = join(root, "home");
    for (const directory of [workspace, grokHome, processHome]) mkdirSync(directory, { mode: 0o700 });
    const profile = join(grokHome, "qm-agent.md");
    writeFileSync(
      profile,
      `---\nname: qm\ndescription: QM controlled agent.\nprompt_mode: full\nmodel: ${model}\npermission_mode: default\nagents_md: false\ntools:\n  - use_tool\ndisallowedTools:\n  - search_tool\n---\n\nUse only the supplied QM MCP tools.\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(grokHome, "config.toml"),
      `[auth]\nauth_provider_command = '/bin/cat "$GROK_HOME/access-token"'\nauth_token_ttl = 900\n\n[compat.claude]\nmcps = false\nhooks = false\n\n[agent]\ndefinition = ${tomlLiteral(profile)}\n`,
      { mode: 0o600 },
    );
    const env = grokChildEnv(source, { root, grokHome, processHome });
    return {
      root,
      workspace,
      grokHome,
      processHome,
      env,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function containsRefreshMaterial(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => /refresh/i.test(key) || (typeof nested === "object" && containsRefreshMaterial(nested)),
  );
}

export async function authenticateGrokHome(
  binaryPath: string,
  turnHome: GrokTurnHome,
  accessToken: string,
  processOptions: Pick<GrokProcessOptions, "launcherPath" | "eofGraceMs" | "termGraceMs" | "killGraceMs"> = {},
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  const tokenPath = join(turnHome.grokHome, "access-token");
  writeFileSync(tokenPath, accessToken, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const login = startGrokProcess(binaryPath, ["login"], {
    cwd: turnHome.workspace,
    env: turnHome.env,
    eofGraceMs: processOptions.eofGraceMs,
    termGraceMs: processOptions.termGraceMs,
    killGraceMs: processOptions.killGraceMs,
  });
  login.child.stdin.end();
  login.child.stdout.resume();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    const exit = await Promise.race([
      login.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Grok external authentication timed out")), timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        abort = () => {
          void login.stop().catch(() => undefined);
          reject(new Error("Grok external authentication was cancelled"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
    if (exit.code !== 0) throw new Error("Grok external authentication failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (existsSync(tokenPath)) unlinkSync(tokenPath);
    await login.stop();
  }
  const authPath = join(turnHome.grokHome, "auth.json");
  const authInfo = existsSync(authPath) ? lstatSync(authPath) : undefined;
  if (!authInfo?.isFile() || authInfo.uid !== process.getuid?.() || mode(authPath) !== 0o600)
    throw new Error("Grok external authentication was not owner-only");
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  const credentials = Object.values(auth).filter((value) => value !== null && typeof value === "object");
  if (
    credentials.length !== 1 ||
    (credentials[0] as Record<string, unknown>).auth_mode !== "external" ||
    containsRefreshMaterial(credentials[0])
  )
    throw new Error("Grok external authentication produced unexpected credential material");
}
