import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ManagedAgentsCommandLostError,
  ManagedAgentsHitlRejectedError,
  ManagedAgentsSandboxGoneError,
  type ManagedAgentsClient,
  type ManagedAgentsCommandResult,
  type ManagedAgentsCheckpoint,
  type ManagedAgentsSession,
  type ManagedAgentsSessionInfo,
  type ManagedAgentsSessionState,
  type ManagedAgentsSessionSummary,
} from "../../src/sandbox/managed-agents-client.ts";
import { mkdtempSync } from "node:fs";

const GUEST_HOME_DIR = "/workspace/home";

interface FakeRecord {
  sessionId: string;
  sandboxId: string;
  name: string;
  state: ManagedAgentsSessionState;
  home: string;
  createdAt: number;
  loseNextCommand: boolean;
  rejectNextCommand: boolean;
  failNextCheckpoint: boolean;
  failNextCheckpointDelete: boolean;
  failNextRollback: boolean;
}

export interface FakeManagedAgents {
  client: ManagedAgentsClient;
  current(name: string): { sessionId: string; sandboxId: string; state: ManagedAgentsSessionState } | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;
  destroy(name: string): void;
  loseNextCommand(name: string): void;
  rejectNextCommand(name: string): void;
  execScripts(): string[];
  pauseCalls(): string[];
  resumeCalls(): string[];
  guestDisconnects(): string[];
  checkpointCalls(): Array<{ sessionId: string; checkpointId: string; label?: string }>;
  deletedCheckpoints(): string[];
  rollbackCalls(): Array<{ sessionId: string; checkpointId: string }>;
  failNextCheckpoint(name: string): void;
  failNextCheckpointDelete(name: string): void;
  failNextRollback(name: string): void;
  cleanup(): void;
}

export function installFakeManagedAgents(): FakeManagedAgents {
  const root = mkdtempSync(join(tmpdir(), "fake-managed-agents-"));
  const records = new Map<string, FakeRecord>();
  const execScripts: string[] = [];
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  const guestDisconnects: string[] = [];
  const checkpointCalls: Array<{ sessionId: string; checkpointId: string; label?: string }> = [];
  const deletedCheckpoints: string[] = [];
  const rollbackCalls: Array<{ sessionId: string; checkpointId: string }> = [];
  let nextId = 1;
  let nextSandbox = 1;
  let nextCheckpoint = 1;
  let clock = 0;

  const gone = (state: ManagedAgentsSessionState): boolean =>
    state === "destroyed" || state === "destroying" || state === "failed";

  const byName = (name: string): FakeRecord | undefined => {
    const all = [...records.values()].filter((r) => r.name === name).sort((a, b) => b.createdAt - a.createdAt);
    return all.find((r) => !gone(r.state)) ?? all[0];
  };

  const need = (name: string): FakeRecord => {
    const r = byName(name);
    if (!r) throw new Error(`fake-managed-agents: no session named ${name}`);
    return r;
  };

  const remap = (r: FakeRecord, script: string): string => {
    const homeRe = r.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(r.home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replaceAll(GUEST_HOME_DIR, r.home)
        .replace(remapPath, (mm) => (mm.startsWith(r.home) ? mm : `${r.home}/tmp/`))
    );
  };

  const alive = (r: FakeRecord): void => {
    if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
    if (r.state === "paused") r.state = "ready";
  };

  const info = (r: FakeRecord): ManagedAgentsSessionInfo => ({
    sessionId: r.sessionId,
    sandboxId: r.sandboxId,
    name: r.name,
    state: r.state,
    createdAtMs: r.createdAt,
  });

  const session = (r: FakeRecord): ManagedAgentsSession => ({
    sessionId: r.sessionId,
    sandboxId: r.sandboxId,
    async runCommand(command): Promise<ManagedAgentsCommandResult> {
      alive(r);
      if (r.loseNextCommand) {
        r.loseNextCommand = false;
        r.state = "destroyed";
        throw new ManagedAgentsCommandLostError(r.sessionId, "sandbox is not running anymore");
      }
      if (r.rejectNextCommand) {
        r.rejectNextCommand = false;
        throw new ManagedAgentsHitlRejectedError(r.sessionId);
      }
      execScripts.push(command);
      mkdirSync(join(r.home, "tmp"), { recursive: true });
      const spawned = spawnSync("sh", ["-c", remap(r, command)], {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      return {
        stdout: (spawned.stdout ?? Buffer.alloc(0)).toString("utf8"),
        stderr: (spawned.stderr ?? Buffer.alloc(0)).toString("utf8"),
        exitCode: spawned.status ?? (spawned.signal ? 137 : -1),
      };
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      alive(r);
      const hostPath = absPath.startsWith(GUEST_HOME_DIR) ? r.home + absPath.slice(GUEST_HOME_DIR.length) : absPath;
      if (!existsSync(hostPath)) return null;
      return new Uint8Array(readFileSync(hostPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      const hostPath = absPath.startsWith(GUEST_HOME_DIR) ? r.home + absPath.slice(GUEST_HOME_DIR.length) : absPath;
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, Buffer.from(data));
    },
    async createCheckpoint(label?: string): Promise<ManagedAgentsCheckpoint> {
      if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
      if (r.failNextCheckpoint) {
        r.failNextCheckpoint = false;
        throw new Error("do-managed-agents create checkpoint: http 500 capture failed");
      }
      const checkpointId = `cp-${nextCheckpoint++}`;
      checkpointCalls.push({ sessionId: r.sessionId, checkpointId, ...(label ? { label } : {}) });
      return { checkpointId, status: "READY", createdAtMs: Date.now() };
    },
    async deleteCheckpoint(checkpointId: string): Promise<void> {
      if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
      if (r.failNextCheckpointDelete) {
        r.failNextCheckpointDelete = false;
        throw new Error("do-managed-agents delete checkpoint: http 500 delete failed");
      }
      deletedCheckpoints.push(checkpointId);
    },
    async close(): Promise<void> {
      guestDisconnects.push(r.sessionId);
    },
    async pause(): Promise<void> {
      if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
      guestDisconnects.push(r.sessionId);
      pauseCalls.push(r.sessionId);
      r.state = "paused";
    },
    async resume(): Promise<void> {
      if (gone(r.state)) throw new ManagedAgentsSandboxGoneError(r.sessionId, `status ${r.state}`);
      resumeCalls.push(r.sessionId);
      r.state = "ready";
    },
    async kill(): Promise<void> {
      guestDisconnects.push(r.sessionId);
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
  });

  const client: ManagedAgentsClient = {
    nativePause: true,
    async info(sessionId): Promise<ManagedAgentsSessionInfo> {
      const r = records.get(sessionId);
      if (!r || gone(r.state)) throw new ManagedAgentsSandboxGoneError(sessionId, "session was not found");
      return info(r);
    },
    async create(opts): Promise<ManagedAgentsSession> {
      const id = `sess-${nextId++}`;
      const r: FakeRecord = {
        sessionId: id,
        sandboxId: `sbx-${id}`,
        name: opts.name,
        state: "ready",
        home: join(root, id),
        createdAt: ++clock,
        loseNextCommand: false,
        rejectNextCommand: false,
        failNextCheckpoint: false,
        failNextCheckpointDelete: false,
        failNextRollback: false,
      };
      mkdirSync(r.home, { recursive: true });
      records.set(id, r);
      return session(r);
    },
    async connect(sessionId): Promise<ManagedAgentsSession> {
      const r = records.get(sessionId);
      if (!r || gone(r.state)) throw new ManagedAgentsSandboxGoneError(sessionId, "session was not found");
      if (r.state === "paused") {
        resumeCalls.push(r.sessionId);
        r.state = "ready";
      }
      return session(r);
    },
    async list(name): Promise<ManagedAgentsSessionSummary[]> {
      return [...records.values()]
        .filter((r) => !gone(r.state) && r.name === name)
        .map((r) => ({ sessionId: r.sessionId, sandboxId: r.sandboxId, name: r.name, state: r.state }));
    },
    async rollback(sessionId, checkpointId): Promise<ManagedAgentsSessionInfo> {
      const r = records.get(sessionId);
      if (!r || gone(r.state)) throw new ManagedAgentsSandboxGoneError(sessionId, "session was not found");
      if (r.failNextRollback) {
        r.failNextRollback = false;
        throw new Error("do-managed-agents rollback: http 409 checkpoint is not ready");
      }
      rollbackCalls.push({ sessionId, checkpointId });
      r.sandboxId = `sbx-restored-${nextSandbox++}`;
      r.state = "ready";
      return info(r);
    },
    async kill(sessionId): Promise<void> {
      const r = records.get(sessionId);
      if (!r) return;
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
  };

  return {
    client,
    current: (name) => {
      const r = byName(name);
      return r && !gone(r.state) ? { sessionId: r.sessionId, sandboxId: r.sandboxId, state: r.state } : null;
    },
    createdCount: (name) => [...records.values()].filter((r) => r.name === name).length,
    homeDir: (name) => need(name).home,
    pause: (name) => {
      need(name).state = "paused";
    },
    destroy: (name) => {
      const r = need(name);
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
    loseNextCommand: (name) => {
      need(name).loseNextCommand = true;
    },
    rejectNextCommand: (name) => {
      need(name).rejectNextCommand = true;
    },
    checkpointCalls: () => [...checkpointCalls],
    deletedCheckpoints: () => [...deletedCheckpoints],
    failNextCheckpoint: (name) => {
      need(name).failNextCheckpoint = true;
    },
    failNextCheckpointDelete: (name) => {
      need(name).failNextCheckpointDelete = true;
    },
    rollbackCalls: () => [...rollbackCalls],
    failNextRollback: (name) => {
      need(name).failNextRollback = true;
    },
    execScripts: () => [...execScripts],
    pauseCalls: () => [...pauseCalls],
    resumeCalls: () => [...resumeCalls],
    guestDisconnects: () => [...guestDisconnects],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
