import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { leasesDir, poolStore } from "./pool.ts";
import { pidAlive } from "./proc.ts";
import { fileMtimeEpoch, formatAge, nowEpoch, todayYmd } from "./util.ts";
import type { LeaseInfo } from "./types.ts";

export const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_SEC = 90;
const CHILD_PID_FILES = ["core.pid", "slack.pid", "web.pid", "admin.pid", "portal.pid"];

export function lockDir(slot: string, store = poolStore()): string {
  return join(leasesDir(store), `${slot}.lock`);
}

export function claimSlotLock(slot: string, store = poolStore()): boolean {
  try {
    mkdirSync(lockDir(slot, store));
    return true;
  } catch {
    return false;
  }
}

export function releaseSlotLock(slot: string, store = poolStore()): void {
  rmSync(lockDir(slot, store), { recursive: true, force: true });
}

export function readMeta(lock: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(join(lock, "meta"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function writeMeta(lock: string, meta: Record<string, string>): void {
  const body = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(lock, "meta"), body + "\n");
}

export function readPidFile(lock: string, name: string): number | null {
  try {
    const pid = Number(readFileSync(join(lock, name), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(lock: string, name: string, pid: number): void {
  writeFileSync(join(lock, name), `${pid}\n`);
}

export function writeHeartbeat(lock: string, phase: string): void {
  const tmp = join(lock, "heartbeat.json.tmp");
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: nowEpoch(), phase }));
  renameSync(tmp, join(lock, "heartbeat.json"));
}

function readHeartbeat(lock: string): { pid: number; at: number; phase: string } | null {
  try {
    return JSON.parse(readFileSync(join(lock, "heartbeat.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readState(lock: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(lock, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

export function leaseOrgId(lease: LeaseInfo): string {
  try {
    const spec = JSON.parse(readFileSync(join(lease.lockDir, "boot-spec.json"), "utf8")) as {
      callerEnv?: { DEV_INSTANCE_ORG_ID?: unknown };
    };
    const orgId = spec.callerEnv?.DEV_INSTANCE_ORG_ID;
    return typeof orgId === "string" && orgId ? orgId : "acme";
  } catch {
    return "acme";
  }
}

export function writeState(lock: string, state: Record<string, unknown>): void {
  const tmp = join(lock, "state.json.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(lock, "state.json"));
}

export function listLeases(store = poolStore()): LeaseInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(leasesDir(store)).filter((e) => e.endsWith(".lock"));
  } catch {
    return [];
  }
  return entries.map((e) => {
    const lock = join(leasesDir(store), e);
    return {
      slot: e.replace(/\.lock$/, ""),
      lockDir: lock,
      meta: readMeta(lock),
      heartbeat: readHeartbeat(lock),
      state: readState(lock),
    };
  });
}

export function myLease(worktree: string, store = poolStore()): LeaseInfo | null {
  return listLeases(store).find((l) => l.meta.worktree === worktree) ?? null;
}

function anyChildAlive(lock: string): boolean {
  return CHILD_PID_FILES.some((f) => pidAlive(readPidFile(lock, f)));
}

export function supervisorAlive(lease: LeaseInfo): boolean {
  const pid = lease.heartbeat?.pid ?? Number(lease.meta.supervisor_pid ?? 0);
  return pidAlive(pid);
}

export function heartbeatFresh(lease: LeaseInfo, nowSec = nowEpoch()): boolean {
  return lease.heartbeat !== null && nowSec - lease.heartbeat.at <= HEARTBEAT_STALE_SEC;
}

export function leaseStale(lease: LeaseInfo): boolean {
  const wt = lease.meta.worktree;
  if (!wt) {
    return nowEpoch() - fileMtimeEpoch(lease.lockDir) > 60;
  }
  if (!existsSync(wt)) return true;
  if (lease.heartbeat) {
    return !heartbeatFresh(lease) && !supervisorAlive(lease) && !anyChildAlive(lease.lockDir);
  }
  if (lease.meta.booting === "1") {
    if (pidAlive(Number(lease.meta.owner_pid ?? 0))) return false;
    return !anyChildAlive(lease.lockDir);
  }
  return !anyChildAlive(lease.lockDir);
}

export function leaseStartedEpoch(lease: LeaseInfo): number {
  const epoch = Number(lease.meta.created_epoch ?? NaN);
  if (Number.isFinite(epoch) && epoch > 0) return epoch;
  const parsed = Date.parse(lease.meta.created?.replace(" ", "T") ?? "");
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return fileMtimeEpoch(join(lease.lockDir, "meta"));
}

const RECLAIM_AFTER_SEC = Number(process.env.DEV_INSTANCE_RECLAIM_AFTER_SECONDS || 14_400);

export function leaseReclaimReason(lease: LeaseInfo, nowSec = nowEpoch()): string | null {
  if (process.env.DEV_INSTANCE_RECLAIM_STALE === "0") return null;
  if (heartbeatFresh(lease, nowSec) && supervisorAlive(lease)) return null;
  const started = leaseStartedEpoch(lease);
  const age = nowSec - started;
  const day = todayYmd(started);
  if (lease.heartbeat && !heartbeatFresh(lease, nowSec) && !supervisorAlive(lease) && !anyChildAlive(lease.lockDir)) {
    return "supervisor dead, heartbeat stale";
  }
  if (lease.heartbeat) return null;
  if (day !== todayYmd(nowSec)) return `started on ${day}, not today`;
  if (age > RECLAIM_AFTER_SEC) return `age ${formatAge(age)} exceeds ${formatAge(RECLAIM_AFTER_SEC)}`;
  return null;
}

export function takenSummary(store = poolStore()): string {
  const parts = listLeases(store).map((l) => {
    const slot = l.meta.slot || l.slot;
    const age = formatAge(nowEpoch() - leaseStartedEpoch(l));
    return `${slot}(${l.meta.branch || "?"}, age=${age})`;
  });
  return parts.length ? parts.join(", ") : "none";
}
