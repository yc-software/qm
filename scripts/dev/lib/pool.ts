import { mkdirSync, readdirSync, chmodSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bestEffort, readEnvFile } from "./util.ts";
import type { SlotPorts } from "./types.ts";

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const QM_CONFIG_DIR = join(CONFIG_HOME, "qm");

export function poolStore(): string {
  if (process.env.QM_POOL_STORE) return process.env.QM_POOL_STORE;
  if (process.env.DEV_INSTANCE_POOL_STORE) return process.env.DEV_INSTANCE_POOL_STORE;
  return join(QM_CONFIG_DIR, "slack-pool");
}

export function liveEnvPath(): string {
  if (process.env.QM_DEV_ENV) return process.env.QM_DEV_ENV;
  if (process.env.DEV_INSTANCE_LIVE_ENV) return process.env.DEV_INSTANCE_LIVE_ENV;
  return join(QM_CONFIG_DIR, "dev.env");
}

export function leasesDir(store = poolStore()): string {
  return join(store, "leases");
}

export function ensureStore(store = poolStore()): void {
  mkdirSync(leasesDir(store), { recursive: true, mode: 0o700 });
  bestEffort(() => chmodSync(store, 0o700));
  bestEffort(() => chmodSync(leasesDir(store), 0o700));
}

export function listSlots(store = poolStore()): string[] {
  let files: string[];
  try {
    files = readdirSync(store);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^pool[1-9][0-9]*\.env$/.test(f))
    .map((f) => f.replace(/\.env$/, ""))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

export interface SlotTokens {
  botToken: string;
  appToken: string;
  handle: string;
  canaryChannel: string;
  extra: Record<string, string>;
}

export function slotTokens(slot: string, store = poolStore()): SlotTokens {
  const env = readEnvFile(join(store, `${slot}.env`));
  return {
    botToken: env.SLACK_BOT_TOKEN ?? "",
    appToken: env.SLACK_APP_TOKEN ?? "",
    handle: env.HANDLE ?? "",
    canaryChannel: env.CANARY_CHANNEL ?? "",
    extra: env,
  };
}

export function slotValid(slot: string, store = poolStore()): boolean {
  const t = slotTokens(slot, store);
  return t.botToken.startsWith("xoxb-") && t.appToken.startsWith("xapp-");
}

export function slotPorts(slot: string, basePort = Number(process.env.DEV_INSTANCE_BASE_PORT || 8080)): SlotPorts {
  const num = Number(slot.replace(/^pool/, ""));
  return {
    core: basePort + num,
    web: basePort + 16 + num,
    admin: basePort + 32 + num,
    portal: basePort + 48 + num,
    prodProxy: basePort + 64 + num,
    slackHealth: basePort + 80 + num,
    supervisor: basePort + 96 + num,
  };
}

export interface SlotFlag {
  reason: string;
  at: number;
  detail?: string;
}

function flagPath(slot: string, store: string): string {
  return join(store, `${slot}.flag.json`);
}

export function readSlotFlag(slot: string, store = poolStore()): SlotFlag | null {
  try {
    return JSON.parse(readFileSync(flagPath(slot, store), "utf8")) as SlotFlag;
  } catch {
    return null;
  }
}

export function writeSlotFlag(slot: string, flag: SlotFlag, store = poolStore()): void {
  writeFileSync(flagPath(slot, store), JSON.stringify(flag, null, 2));
}

export function clearSlotFlag(slot: string, store = poolStore()): void {
  rmSync(flagPath(slot, store), { force: true });
}

const FLAG_TTL_SEC = 30 * 60;

export function slotFlagged(slot: string, store = poolStore(), nowSec = Math.floor(Date.now() / 1000)): boolean {
  const flag = readSlotFlag(slot, store);
  if (!flag) return false;
  if (nowSec - flag.at > FLAG_TTL_SEC) {
    clearSlotFlag(slot, store);
    return false;
  }
  return true;
}
