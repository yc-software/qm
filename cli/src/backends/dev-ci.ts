import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { die, note, ok } from "../log.ts";
import { envNum, gitTopLevel, spawnBackground, stopPid, tail, waitForLog, which } from "../util.ts";
import { serviceDef } from "../services.ts";

const ciDir = (root: string): string => join(root, process.env.CI_INSTANCE_DIR ?? ".ci-instance");
const ciPort = (): number => envNum("CI_INSTANCE_PORT", 8181);
const readyTimeout = (): number => envNum("CI_INSTANCE_READY_TIMEOUT", 60);
const pidFromFile = (dir: string, name: string): number | undefined => {
  const path = join(dir, `${name}.pid`);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};
const writePid = (dir: string, name: string, pid: number): void => writeFileSync(join(dir, `${name}.pid`), String(pid));

async function startTunnel(port: number, dir: string): Promise<string | undefined> {
  if (!which("cloudflared")) return undefined;
  const logFile = join(dir, "tunnel.log");
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  writePid(
    dir,
    "tunnel",
    spawnBackground("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { logFile }),
  );
  if (!(await waitForLog(logFile, url, 30))) return undefined;
  return readFileSync(logFile, "utf8").match(url)?.[0];
}

function requireEnv(): void {
  const bot = process.env.SLACK_BOT_TOKEN ?? "";
  const app = process.env.SLACK_APP_TOKEN ?? "";
  if (!bot.startsWith("xoxb-")) die("SLACK_BOT_TOKEN (xoxb-…) required");
  if (process.env.SLACK_EVENTS_MODE === "http") {
    if (!process.env.SLACK_SIGNING_SECRET) die("SLACK_SIGNING_SECRET required in http events mode");
  } else if (!app.startsWith("xapp-")) die("SLACK_APP_TOKEN (xapp-…) required");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    die(
      "a model provider key required (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY — live turns are the point of this instance)",
    );
  }
  if (!process.env.CORE_SIGNING_SECRET) die("CORE_SIGNING_SECRET required");
}

function requireDeps(root: string): void {
  if (!existsSync(join(root, "node_modules"))) die("core deps missing — run 'npm ci' first");
}

async function dieWithTail(logFile: string, msg: string): Promise<never> {
  note(`--- ${basename(logFile)} (tail) ---`);
  note(tail(logFile, 30));
  await devCiDown();
  die(msg);
}

export async function devCiUp(): Promise<void> {
  const root = gitTopLevel();
  requireEnv();
  requireDeps(root);

  const dir = ciDir(root);
  mkdirSync(dir, { recursive: true });
  for (const f of ["core.log", "tunnel.log"]) writeFileSync(join(dir, f), "");
  const port = ciPort();

  const overlay: Record<string, string> = { HARNESS: process.env.HARNESS ?? "pi" };
  if (process.env.SLACK_EVENTS_MODE === "http" && !process.env.SLACK_EVENTS_PORT) {
    overlay.SLACK_EVENTS_PORT = String(port + 1);
  }
  if (process.env.SPRITES_TOKEN) {
    if (!process.env.SANDBOX_BACKEND) overlay.SANDBOX_BACKEND = "sprites";
    if (!process.env.SPRITES_NAME_PREFIX) overlay.SPRITES_NAME_PREFIX = "qmci";
  }

  if (!process.env.PUBLIC_API_URL && process.env.SPRITES_TOKEN) {
    const url = await startTunnel(port, dir);
    if (!url) {
      await devCiDown();
      die("cloudflared tunnel didn't come up (sandbox self-API scenarios would silently fail)");
    }
    overlay.PUBLIC_API_URL = url;
    note(`agent self-API tunnel: ${url} → :${port}`);
  }

  const baseEnv = { ...process.env, ...overlay } as NodeJS.ProcessEnv;

  const coreLog = join(dir, "core.log");
  const corePid = spawnBackground(process.execPath, [...serviceDef("core").dev.entry], {
    cwd: root,
    env: { ...baseEnv, ORG_ID: "acme", SESSION_STORE: "memory", PORT: String(port) },
    logFile: coreLog,
  });
  writePid(dir, "core", corePid);
  if (!(await waitForLog(coreLog, serviceDef("core").readiness, readyTimeout()))) {
    await dieWithTail(coreLog, `core failed to start on :${port}`);
  }
  if (!(await waitForLog(coreLog, /connected as @/, readyTimeout()))) {
    await dieWithTail(coreLog, "slack surface failed to connect (bad/uninstalled CI app token?)");
  }

  const handle = readFileSync(coreLog, "utf8").match(/connected as @([^\s]+)/)?.[1] ?? "agent";
  ok(`ci instance up — core :${port}, slack @${handle}`);

  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `CORE_API_URL=http://localhost:${port}\nAGENT_HANDLE=${handle}\n`);
  }
}

export async function devCiDown(): Promise<void> {
  let root: string;
  try {
    root = gitTopLevel();
  } catch {
    note("nothing to tear down (not in a checkout).");
    return;
  }
  const dir = ciDir(root);
  if (!existsSync(dir)) {
    note("nothing to tear down.");
    return;
  }
  for (const name of ["core", "tunnel"]) await stopPid(pidFromFile(dir, name));
  for (const name of ["core", "tunnel"]) rmSync(join(dir, `${name}.pid`), { force: true });

  ok(`ci instance down (logs kept in ${process.env.CI_INSTANCE_DIR ?? ".ci-instance"}/)`);
}
