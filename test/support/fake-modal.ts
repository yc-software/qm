import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ModalNameConflictError,
  ModalSandboxGoneError,
  type ModalClient,
  type ModalCommandResult,
  type ModalSession,
} from "../../src/sandbox/modal-client.ts";

interface FakeRecord {
  sandboxId: string;
  name?: string;
  state: "running" | "terminated";
  home: string;
  createdAt: number;
}

export interface FakeModal {
  client: ModalClient;
  current(name: string): { sandboxId: string; state: string } | null;
  createdCount(name: string): number;
  totalCreated(): number;
  runningCount(): number;
  homeDir(name: string): string;
  terminate(name: string): void;
  terminateAllRunning(): void;
  failTerminateOnce(): void;
  execScripts(): string[];
  cleanup(): void;
}

export function installFakeModal(opts: { native?: boolean } = {}): FakeModal {
  const root = mkdtempSync(join(tmpdir(), "fake-modal-"));
  const records = new Map<string, FakeRecord>();
  const execScripts: string[] = [];
  let nextId = 1;
  let clock = 0;
  let terminateFailures = 0;

  const byName = (name: string): FakeRecord | undefined => {
    const all = [...records.values()].filter((r) => r.name === name).sort((a, b) => b.createdAt - a.createdAt);
    return all.find((r) => r.state === "running") ?? all[0];
  };

  const remap = (r: FakeRecord, script: string): string => {
    const homeRe = r.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(r.home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replace(/\/root(?![A-Za-z0-9_-])/g, r.home)
        .replace(remapPath, (mm) => (mm.startsWith(r.home) ? mm : `${r.home}/tmp/`))
    );
  };

  const alive = (r: FakeRecord): void => {
    if (r.state === "terminated") throw new ModalSandboxGoneError(r.sandboxId, "sandbox has been terminated");
  };

  const kill = (r: FakeRecord): void => {
    r.state = "terminated";
    rmSync(r.home, { recursive: true, force: true });
  };

  const session = (r: FakeRecord): ModalSession => ({
    sandboxId: r.sandboxId,
    ...(opts.native
      ? {
          async snapshotHome(): Promise<{ imageId: string; expiresAtMs: number }> {
            alive(r);
            const imageId = `im-${nextId++}`;
            cpSync(r.home, join(root, imageId), { recursive: true });
            return { imageId, expiresAtMs: Date.now() + 30 * 24 * 3600_000 };
          },
          async restoreHome(imageId: string): Promise<void> {
            alive(r);
            cpSync(join(root, imageId), r.home, { recursive: true });
          },
        }
      : {}),
    async runCommand(command): Promise<ModalCommandResult> {
      alive(r);
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
      const hostPath = absPath.replace(/^\/root(?![A-Za-z0-9_-])/, r.home);
      if (!existsSync(hostPath)) return null;
      return new Uint8Array(readFileSync(hostPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      const hostPath = absPath.replace(/^\/root(?![A-Za-z0-9_-])/, r.home);
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, Buffer.from(data));
    },
    async terminate(): Promise<void> {
      if (terminateFailures > 0) {
        terminateFailures--;
        throw new Error("simulated terminate outage");
      }
      kill(r);
    },
  });

  const client: ModalClient = {
    nativeSnapshots: opts.native ?? false,
    async create(opts): Promise<ModalSession> {
      if (opts.name) {
        const existing = byName(opts.name);
        if (existing && existing.state === "running") {
          throw new ModalNameConflictError(opts.name, "sandbox with this name already exists");
        }
      }
      const id = `sb-${nextId++}`;
      const r: FakeRecord = {
        sandboxId: id,
        ...(opts.name ? { name: opts.name } : {}),
        state: "running",
        home: join(root, id),
        createdAt: ++clock,
      };
      mkdirSync(r.home, { recursive: true });
      records.set(id, r);
      return session(r);
    },
    async fromId(sandboxId): Promise<ModalSession> {
      const r = records.get(sandboxId);
      if (!r || r.state === "terminated") throw new ModalSandboxGoneError(sandboxId, "sandbox not found");
      return session(r);
    },
    async fromName(name): Promise<ModalSession | null> {
      const r = byName(name);
      if (!r || r.state === "terminated") return null;
      return session(r);
    },
    async terminate(sandboxId): Promise<void> {
      const r = records.get(sandboxId);
      if (!r) return;
      kill(r);
    },
  };

  return {
    client,
    current: (name) => {
      const r = byName(name);
      return r && r.state === "running" ? { sandboxId: r.sandboxId, state: r.state } : null;
    },
    createdCount: (name) => [...records.values()].filter((r) => r.name === name).length,
    totalCreated: () => records.size,
    runningCount: () => [...records.values()].filter((r) => r.state === "running").length,
    homeDir: (name) => {
      const r = byName(name);
      if (!r) throw new Error(`fake-modal: no sandbox named ${name}`);
      return r.home;
    },
    terminate: (name) => {
      const r = byName(name);
      if (r) kill(r);
    },
    terminateAllRunning: () => {
      for (const r of records.values()) if (r.state === "running") kill(r);
    },
    failTerminateOnce: () => {
      terminateFailures++;
    },
    execScripts: () => [...execScripts],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
