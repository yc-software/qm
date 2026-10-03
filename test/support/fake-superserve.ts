import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SuperserveSandboxGoneError,
  type SuperserveClient,
  type SuperserveCommandResult,
  type SuperserveCreateOptions,
  type SuperserveNetwork,
  type SuperserveSandboxInfo,
  type SuperserveSandboxState,
  type SuperserveSession,
  type SuperserveUpdate,
} from "../../src/sandbox/superserve-client.ts";

interface FakeRecord {
  id: string;
  name: string;
  status: SuperserveSandboxState;
  expired: boolean;
  metadata: Record<string, string>;
  network?: SuperserveNetwork;
  timeoutSeconds?: number;
  autoDeleteSeconds?: number;
  template?: string;
  home: string;
  createdAt: number;
  resumes: number;
}

export interface FakeSuperserve {
  client: SuperserveClient;
  current(name: string): FakeRecord | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;
  fail(name: string): void;
  expire(name: string): void;
  execScripts(): string[];
  calls(): string[];
  failNextList(error: Error): void;
  failNextKill(error: Error): void;
  acceptNetworkUpdateWhilePaused(): void;
  ignoreNetworkUpdateWhilePaused(): void;
  beforeNextRun(hook: () => Promise<void>): void;
  beforeNextInfo(hook: () => Promise<void>): void;
  cleanup(): void;
}

export function installFakeSuperserve(): FakeSuperserve {
  const root = mkdtempSync(join(tmpdir(), "fake-superserve-"));
  const records = new Map<string, FakeRecord>();
  const execScripts: string[] = [];
  const calls: string[] = [];
  let nextId = 1;
  let clock = 0;
  let listFailure: Error | null = null;
  let runHook: (() => Promise<void>) | null = null;
  let infoHook: (() => Promise<void>) | null = null;
  let killFailure: Error | null = null;
  let pausedNetworkUpdates = false;
  let silentlyIgnorePausedNetwork = false;

  const byName = (name: string): FakeRecord | undefined => {
    const all = [...records.values()].filter((r) => r.name === name).sort((a, b) => b.createdAt - a.createdAt);
    return all.find((r) => !r.expired) ?? all[0];
  };

  const reap = (r: FakeRecord): void => {
    calls.push(`kill:${r.id}`);
    r.expired = true;
    r.status = "deleted";
    rmSync(r.home, { recursive: true, force: true });
  };

  const gone = (r: FakeRecord): never => {
    throw new SuperserveSandboxGoneError(r.id, "sandbox was not found");
  };

  const alive = (r: FakeRecord): void => {
    if (r.expired) gone(r);
    if (r.status === "paused") {
      r.status = "active";
      r.resumes += 1;
    }
  };

  const remap = (r: FakeRecord, script: string): string =>
    script
      .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
      .replace(/(^|[^A-Za-z0-9._/-])\/tmp\//g, `$1${r.home}/tmp/`)
      .replace(/(^|[^A-Za-z0-9._/-])\/root(?=\/|$|[^A-Za-z0-9._/-])/g, `$1${r.home}`);

  const hostPath = (r: FakeRecord, absPath: string): string => {
    if (absPath.startsWith("/tmp/")) return join(r.home, "tmp", absPath.slice(5));
    if (absPath === "/root" || absPath.startsWith("/root/")) return join(r.home, absPath.slice(5));
    return absPath;
  };

  const session = (r: FakeRecord): SuperserveSession => ({
    id: r.id,
    async run(command): Promise<SuperserveCommandResult> {
      const hook = runHook;
      runHook = null;
      if (hook) await hook();
      alive(r);
      calls.push(`run:${r.id}`);
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
      const p = hostPath(r, absPath);
      if (!existsSync(p)) return null;
      return new Uint8Array(readFileSync(p));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      const p = hostPath(r, absPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, Buffer.from(data));
    },
    async update(patch: SuperserveUpdate): Promise<void> {
      if (r.expired) gone(r);
      calls.push(`update:${r.id}`);
      const dropNetwork = patch.network !== undefined && r.status !== "active" && silentlyIgnorePausedNetwork;
      if (patch.network !== undefined && r.status !== "active" && !pausedNetworkUpdates && !dropNetwork)
        throw Object.assign(new Error("Sandbox must be active to update network config"), { statusCode: 409 });
      if (patch.network !== undefined && !dropNetwork) r.network = patch.network;
      if (patch.metadata !== undefined) r.metadata = { ...patch.metadata };
      if (patch.timeoutSeconds !== undefined) r.timeoutSeconds = patch.timeoutSeconds ?? undefined;
      if (patch.autoDeleteSeconds !== undefined) r.autoDeleteSeconds = patch.autoDeleteSeconds ?? undefined;
    },
    async pause(): Promise<void> {
      if (r.expired) gone(r);
      calls.push(`pause:${r.id}`);
      r.status = "paused";
    },
    async kill(): Promise<void> {
      if (killFailure) {
        const failure = killFailure;
        killFailure = null;
        throw failure;
      }
      calls.push(`kill:${r.id}`);
      r.expired = true;
      r.status = "deleted";
      rmSync(r.home, { recursive: true, force: true });
    },
  });

  const readBack = (rules: string[] | undefined): string[] | undefined =>
    rules?.map((rule) => (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rule) ? `${rule}/32` : rule));
  const info = (r: FakeRecord): SuperserveSandboxInfo => ({
    id: r.id,
    name: r.name,
    status: r.status,
    metadata: r.metadata,
    ...(r.network
      ? {
          network: {
            ...(r.network.allowOut ? { allowOut: readBack(r.network.allowOut) } : {}),
            ...(r.network.denyOut ? { denyOut: readBack(r.network.denyOut) } : {}),
          },
        }
      : {}),
    vcpuCount: 2,
    memoryMib: 2048,
    ...(r.timeoutSeconds !== undefined ? { timeoutSeconds: r.timeoutSeconds } : {}),
  });

  const client: SuperserveClient = {
    async create(opts: SuperserveCreateOptions): Promise<SuperserveSession> {
      calls.push(`create:${opts.name}`);
      const id = `sbx-${nextId++}`;
      const r: FakeRecord = {
        id,
        name: opts.name,
        status: "active",
        expired: false,
        metadata: { ...opts.metadata },
        ...(opts.network ? { network: opts.network } : {}),
        ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
        ...(opts.autoDeleteSeconds !== undefined ? { autoDeleteSeconds: opts.autoDeleteSeconds } : {}),
        ...(opts.template ? { template: opts.template } : {}),
        home: join(root, id),
        createdAt: ++clock,
        resumes: 0,
      };
      mkdirSync(r.home, { recursive: true });
      records.set(id, r);
      return session(r);
    },
    async update(sandboxId, patch): Promise<void> {
      const r = records.get(sandboxId);
      if (!r || r.expired) throw new SuperserveSandboxGoneError(sandboxId, "sandbox was not found");
      await session(r).update(patch);
    },
    async connect(sandboxId): Promise<SuperserveSession> {
      calls.push(`connect:${sandboxId}`);
      const r = records.get(sandboxId);
      if (!r || r.expired) throw new SuperserveSandboxGoneError(sandboxId, "sandbox was not found");
      alive(r);
      return session(r);
    },
    async info(sandboxId, scopeMetadata): Promise<SuperserveSandboxInfo> {
      const hook = infoHook;
      infoHook = null;
      if (hook) await hook();
      const r = records.get(sandboxId);
      const matches = Object.entries(scopeMetadata ?? {}).every(([k, v]) => r?.metadata[k] === v);
      if (r && r.status === "failed") reap(r);
      if (!r || r.expired || !matches) throw new SuperserveSandboxGoneError(sandboxId, "sandbox was not found");
      return info(r);
    },
    async list(metadata): Promise<SuperserveSandboxInfo[]> {
      if (listFailure) {
        const error = listFailure;
        listFailure = null;
        throw error;
      }
      const matching = [...records.values()].filter(
        (r) => !r.expired && Object.entries(metadata).every(([k, v]) => r.metadata[k] === v),
      );
      for (const r of matching.filter((r) => r.status === "failed")) reap(r);
      return matching.filter((r) => !r.expired).map(info);
    },
    async kill(sandboxId): Promise<void> {
      calls.push(`kill:${sandboxId}`);
      const r = records.get(sandboxId);
      if (!r) return;
      r.expired = true;
      r.status = "deleted";
      rmSync(r.home, { recursive: true, force: true });
    },
  };

  return {
    client,
    current: (name) => {
      const r = byName(name);
      return r && !r.expired ? r : null;
    },
    createdCount: (name) => [...records.values()].filter((r) => r.name === name).length,
    homeDir: (name) => {
      const r = byName(name);
      if (!r) throw new Error(`fake-superserve: no sandbox named ${name}`);
      return r.home;
    },
    pause: (name) => {
      const r = byName(name);
      if (r) r.status = "paused";
    },
    fail: (name) => {
      const r = byName(name);
      if (r) r.status = "failed";
    },
    expire: (name) => {
      const r = byName(name);
      if (r) {
        r.expired = true;
        r.status = "deleted";
        rmSync(r.home, { recursive: true, force: true });
      }
    },
    execScripts: () => [...execScripts],
    calls: () => [...calls],
    failNextList: (error) => {
      listFailure = error;
    },
    beforeNextRun: (hook) => {
      runHook = hook;
    },
    beforeNextInfo: (hook) => {
      infoHook = hook;
    },
    failNextKill: (error) => {
      killFailure = error;
    },
    acceptNetworkUpdateWhilePaused: () => {
      pausedNetworkUpdates = true;
    },
    ignoreNetworkUpdateWhilePaused: () => {
      silentlyIgnorePausedNetwork = true;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
