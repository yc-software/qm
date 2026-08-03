export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  noFreeSlot: 3,
  childFailed: 4,
  verificationFailed: 5,
  slotStolen: 6,
  missingPrereq: 7,
  supervisorUnreachable: 8,
  leaseConflict: 9,
  doctorCritical: 10,
} as const;

export type ChildName = "core" | "web" | "admin" | "portal";
export const CHILD_ORDER: ChildName[] = ["core", "web", "admin", "portal"];

export interface SlotPorts {
  core: number;
  web: number;
  admin: number;
  portal: number;
  prodProxy: number;
  slackHealth: number;
  supervisor: number;
}

export interface ChildSpec {
  name: ChildName;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  port?: number;
  readiness: { kind: "log"; pattern: string } | { kind: "http"; url: string };
  health: { kind: "tcp"; port: number } | { kind: "healthz"; url: string };
  stopGraceMs: number;
}

export type ChildState = "starting" | "healthy" | "unhealthy" | "crashed" | "stopping" | "stopped";

export interface ChildStatus {
  state: ChildState;
  pid: number | null;
  port?: number;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  lastReadyAt: number | null;
}

export interface SlackHealth {
  ok: boolean;
  connectedAs?: string;
  numConnections?: number | null;
  helloHost?: string | null;
  lastEventAt?: number | null;
  lastEventAtRaw?: number | null;
  lastActivityAt?: number | null;
  lastCanary?: { ok: boolean; rttMs?: number; reason?: string; at: number } | null;
}

export interface BootPhaseEvent {
  event: "phase" | "done";
  name?: string;
  state?: "start" | "ok" | "warn" | "fail";
  detail?: string;
  result?: BootResult;
}

export interface BootResult {
  ok: boolean;
  slackEnabled?: boolean;
  reason?: string;
  slot: string;
  handle?: string;
  numConnections?: number | null;
  helloHost?: string | null;
  canary?: { ok: boolean; rttMs?: number; reason?: string } | null;
  rotateSuggested?: boolean;
  failedChild?: ChildName;
  logTail?: string[];
}

export interface StatusReport {
  slot: string;
  state: "live" | "booting" | "degraded" | "down";
  worktree: string;
  branch: string;
  handle: string;
  ports: SlotPorts;
  canary: { channel: string; source: string };
  supervisor: { pid: number; startedAt: number; uptimeSec: number };
  bootedAt: number | null;
  envSha: string;
  gitSha: string;
  sandbox: { backend: string; detail: string };
  durability: { sessionStore: string; runStore: string; databaseUrl: boolean };
  harness: string;
  slackEnabled: boolean;
  watch: boolean;
  turnsLive: boolean;
  publicApiUrl: string | null;
  children: Record<string, ChildStatus & { slack?: SlackHealth }>;
}

export interface BootSpec {
  slot: string;
  worktree: string;
  branch: string;
  callerEnv: Record<string, string>;
  watch: boolean;
  sandbox: "local" | "sprites" | "auto";
  canaryChannel?: string;
  strict: boolean;
  slack?: boolean;
}

export interface LeaseInfo {
  slot: string;
  lockDir: string;
  meta: Record<string, string>;
  heartbeat: { pid: number; at: number; phase: string } | null;
  state: Record<string, unknown> | null;
}
