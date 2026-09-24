import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  E2bCommandLostError,
  E2bSandboxGoneError,
  type E2bClient,
  type E2bCommandResult,
  type E2bMetrics,
  type E2bSession,
} from "../../src/sandbox/e2b-client.ts";

interface FakeRecord {
  sandboxId: string;
  state: "running" | "paused";
  expired: boolean;
  autoPause: boolean;
  metadata: Record<string, string>;
  home: string;
  createdAt: number;
  fromSnapshot?: string;
  timeoutMs: number[];
  loseNextCommand: boolean;
}

export interface FakeE2b {
  client: E2bClient;
  current(name: string): { sandboxId: string; state: string; metadata: Record<string, string> } | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;

  expirePaused(): void;
  loseNextCommand(name: string): void;
  timeouts(name: string): number[];
  snapshots(): string[];
  restoredFrom(name: string): string | undefined;
  metrics: E2bMetrics | null;
  execScripts(): string[];
  cleanup(): void;
}

export function installFakeE2b(): FakeE2b {
  const root = mkdtempSync(join(tmpdir(), "fake-e2b-"));
  const records = new Map<string, FakeRecord>();
  const snapshots = new Map<string, string>();
  const execScripts: string[] = [];
  let nextId = 1;
  let nextSnapshot = 1;
  let clock = 0;

  const byName = (name: string): FakeRecord | undefined => {
    const all = [...records.values()].filter((r) => r.metadata.name === name).sort((a, b) => b.createdAt - a.createdAt);
    return all.find((r) => !r.expired) ?? all[0];
  };

  const remap = (r: FakeRecord, script: string): string => {
    const homeRe = r.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(r.home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replace(/\/home\/user/g, r.home)
        .replace(remapPath, (mm) => (mm.startsWith(r.home) ? mm : `${r.home}/tmp/`))
    );
  };

  const alive = (r: FakeRecord): void => {
    if (r.expired) throw new E2bSandboxGoneError(r.sandboxId, "sandbox was not found");

    if (r.state === "paused") {
      if (!r.autoPause) throw new E2bSandboxGoneError(r.sandboxId, "sandbox is paused and cannot auto-resume");
      r.state = "running";
    }
  };

  const fake: FakeE2b = {
    client: null as unknown as E2bClient,
    metrics: null,
    current: (name) => {
      const r = byName(name);
      return r && !r.expired ? { sandboxId: r.sandboxId, state: r.state, metadata: r.metadata } : null;
    },
    createdCount: (name) => [...records.values()].filter((r) => r.metadata.name === name).length,
    homeDir: (name) => {
      const r = byName(name);
      if (!r) throw new Error(`fake-e2b: no sandbox named ${name}`);
      return r.home;
    },
    pause: (name) => {
      const r = byName(name);
      if (r) r.state = "paused";
    },
    expirePaused: () => {
      for (const r of records.values()) {
        if (r.state === "paused" && !r.expired) {
          r.expired = true;
          rmSync(r.home, { recursive: true, force: true });
        }
      }
    },
    loseNextCommand: (name) => {
      const r = byName(name);
      if (r) r.loseNextCommand = true;
    },
    timeouts: (name) => [...(byName(name)?.timeoutMs ?? [])],
    snapshots: () => [...snapshots.keys()],
    restoredFrom: (name) => byName(name)?.fromSnapshot,
    execScripts: () => [...execScripts],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };

  const session = (r: FakeRecord): E2bSession => ({
    sandboxId: r.sandboxId,
    async runCommand(command, opts): Promise<E2bCommandResult> {
      alive(r);
      if (opts?.timeoutMs) r.timeoutMs.push(opts.timeoutMs);
      if (r.loseNextCommand) {
        r.loseNextCommand = false;
        r.state = "paused";
        throw new E2bCommandLostError(r.sandboxId, "sandbox timeout");
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
      const hostPath = absPath.replace(/^\/home\/user/, r.home);
      if (!existsSync(hostPath)) return null;
      return new Uint8Array(readFileSync(hostPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      const hostPath = absPath.replace(/^\/home\/user/, r.home);
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, Buffer.from(data));
    },
    async keepAlive(ms): Promise<void> {
      alive(r);
      r.timeoutMs.push(ms);
    },
    async pause(): Promise<void> {
      if (r.expired) throw new E2bSandboxGoneError(r.sandboxId, "sandbox was not found");
      r.state = "paused";
    },
    async createSnapshot(): Promise<{ snapshotId: string }> {
      alive(r);
      const snapshotId = `snap-${nextSnapshot++}`;
      const dir = join(root, "snapshots", snapshotId);
      mkdirSync(dirname(dir), { recursive: true });
      cpSync(r.home, dir, { recursive: true });
      snapshots.set(snapshotId, dir);
      return { snapshotId };
    },
    async metrics(): Promise<E2bMetrics | null> {
      alive(r);
      return fake.metrics;
    },
    async kill(): Promise<void> {
      r.expired = true;
      rmSync(r.home, { recursive: true, force: true });
    },
  });

  fake.client = {
    async create(opts): Promise<E2bSession> {
      const id = `sbx-${nextId++}`;
      const r: FakeRecord = {
        sandboxId: id,
        state: "running",
        expired: false,
        autoPause: opts.autoPause ?? false,
        metadata: opts.metadata,
        home: join(root, id),
        createdAt: ++clock,
        timeoutMs: [],
        loseNextCommand: false,
        ...(opts.fromSnapshot ? { fromSnapshot: opts.fromSnapshot } : {}),
      };
      if (opts.fromSnapshot) {
        const dir = snapshots.get(opts.fromSnapshot);
        if (!dir) throw new Error(`fake-e2b: snapshot ${opts.fromSnapshot} not found`);
        cpSync(dir, r.home, { recursive: true });
      } else {
        mkdirSync(r.home, { recursive: true });
      }
      records.set(id, r);
      return session(r);
    },
    async connect(sandboxId): Promise<E2bSession> {
      const r = records.get(sandboxId);
      if (!r || r.expired) throw new E2bSandboxGoneError(sandboxId, "sandbox was not found");
      r.state = "running";
      return session(r);
    },
    async list(metadata): Promise<Array<{ sandboxId: string; state: string; metadata?: Record<string, string> }>> {
      return [...records.values()]
        .filter((r) => !r.expired && Object.entries(metadata).every(([k, v]) => r.metadata[k] === v))
        .map((r) => ({ sandboxId: r.sandboxId, state: r.state, metadata: r.metadata }));
    },
    async kill(sandboxId): Promise<void> {
      const r = records.get(sandboxId);
      if (!r) return;
      r.expired = true;
      rmSync(r.home, { recursive: true, force: true });
    },
    async deleteSnapshot(snapshotId): Promise<void> {
      const dir = snapshots.get(snapshotId);
      if (!dir) return;
      rmSync(dir, { recursive: true, force: true });
      snapshots.delete(snapshotId);
    },
  };

  return fake;
}
