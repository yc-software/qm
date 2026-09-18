import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NotFoundError,
  SandboxError,
  SandboxTimeoutError,
  type SandboxSpec,
  type StatusResponsePhase,
} from "porter-sandbox";
import type { PorterClientLike, PorterSandboxLike } from "../../src/sandbox/porter-client.ts";

export interface FakePorterBody {
  name: string;
  id: string;
  phase: string;
  tags: Record<string, string>;
  host: string;
  image: string;
  snapshotId?: string;
  resources?: SandboxSpec["resources"];
  egress?: string[];
  env?: Record<string, string>;
  networking?: SandboxSpec["networking"];
}

export interface FakePorterOptions {
  terminateLag?: number;
  pageSize?: number;
  assignHost?: boolean;
  filesApi?: "unavailable" | "timeout";
  snapshotFails?: boolean;
}

export interface FakePorter {
  client: PorterClientLike;
  bodies(): FakePorterBody[];
  hostOf(name: string): string;
  statusReads(): number;
  volumeDir(volumeName: string): string;
  volumeNames(): string[];
  volumeFileCalls(): number;
  nameLookups(): number;
  listCalls(): number;
  snapshots(): Array<{ id: string; sandboxId: string }>;
  terminateAll(): void;
  fail(name: string, exitCode: number, logLines: string[]): void;
  execScripts(): string[];
  cleanup(): void;
}

const GUEST_HOME = "/root";
const GUEST_APP = "/app";
const PID_FILE = "qm-app.pid";

interface BodyRecord {
  id: string;
  phase: string;
  terminatingTicks: number;
  tags: Record<string, string>;
  image: string;
  snapshotId?: string;
  resources?: SandboxSpec["resources"];
  home: string;
  app: string;
  tmp: string;
  mounts: Record<string, string>;
  volumeMounts: Record<string, string>;
  host: string;
  startedAt: string;
  exitCode?: number;
  logs: string[];
  egress?: string[];
  env?: Record<string, string>;
  networking?: SandboxSpec["networking"];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathRe = (guestPath: string): RegExp => new RegExp(`${escapeRe(guestPath)}(?![A-Za-z0-9._-])`, "g");

export function installFakePorter(opts: FakePorterOptions = {}): FakePorter {
  const root = mkdtempSync(join(tmpdir(), "fake-porter-"));
  const volumes = new Map<string, { id: string; dir: string }>();
  const bodies = new Map<string, BodyRecord>();
  const snapshots = new Map<string, { sandboxId: string; dir: string }>();
  const execScripts: string[] = [];
  let volumeSeq = 0;
  let bodySeq = 0;
  let snapshotSeq = 0;
  let statusReads = 0;
  let volumeFileCalls = 0;
  let nameLookups = 0;
  let listCalls = 0;

  const settle = (b: BodyRecord): void => {
    if (b.phase !== "terminating") return;
    if (b.terminatingTicks > 0) b.terminatingTicks -= 1;
    if (b.terminatingTicks === 0) b.phase = "terminated";
  };
  const observe = (b: BodyRecord | undefined): BodyRecord | undefined => {
    if (b) settle(b);
    return b;
  };
  const volumeById = (id: string): { id: string; dir: string } | undefined =>
    [...volumes.values()].find((v) => v.id === id);

  const bodyById = (id: string): [string, BodyRecord] | undefined => [...bodies.entries()].find(([, b]) => b.id === id);

  const attachedTo = (vol: { dir: string }): string[] =>
    [...bodies.values()]
      .filter((b) => b.phase !== "terminated" && Object.values(b.mounts).includes(vol.dir))
      .map((b) => b.id);

  const remap = (b: BodyRecord, script: string): string => {
    const remapTmp = new RegExp(`${escapeRe(GUEST_HOME)}/tmp/|/tmp/`, "g");
    let out = script
      .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
      .replace(remapTmp, `${b.tmp}/`)
      .replace(pathRe(GUEST_HOME), b.home)
      .replace(pathRe(GUEST_APP), b.app);
    for (const [guest, dir] of Object.entries(b.mounts))
      if (guest !== GUEST_HOME) out = out.replace(pathRe(guest), dir);
    return `export HOME=${JSON.stringify(b.home)}; ${out}`;
  };

  const killApp = (b: BodyRecord): void => {
    const pidFile = join(b.tmp, PID_FILE);
    if (!existsSync(pidFile)) return;
    const pid = readFileSync(pidFile, "utf8").trim();
    if (!/^\d+$/.test(pid)) return;
    spawnSync("sh", ["-c", `pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; true`]);
  };

  const retire = (b: BodyRecord): void => {
    if (b.phase === "terminated" || b.phase === "terminating") return;
    killApp(b);
    rmSync(b.tmp, { recursive: true, force: true });
    rmSync(b.app, { recursive: true, force: true });
    if (!volumeById(b.tags["qm-volume-id"] ?? "")) rmSync(b.home, { recursive: true, force: true });
    if ((opts.terminateLag ?? 0) > 0) {
      b.phase = "terminating";
      b.terminatingTicks = opts.terminateLag ?? 0;
    } else {
      b.phase = "terminated";
    }
  };

  const sandboxOf = (name: string, statusKnown = true): PorterSandboxLike => {
    let known = statusKnown;
    return {
      id: bodies.get(name)!.id,
      get phase() {
        return known ? (bodies.get(name)?.phase ?? "terminated") : null;
      },
      get tags() {
        return bodies.get(name)?.tags ?? null;
      },
      async refresh() {
        known = true;
        const b = observe(bodies.get(name));
        return {
          name,
          host: b?.host ?? "",
          phase: (b?.phase ?? "terminated") as StatusResponsePhase,
          started_at: b?.startedAt ?? null,
          exit_code: b?.exitCode ?? null,
          volume_mounts: b?.volumeMounts ?? {},
        };
      },
      async terminate() {
        const cur = bodies.get(name);
        if (cur) retire(cur);
      },
      async logs(options) {
        const lines = bodies.get(name)?.logs ?? [];
        return lines.slice(-(options?.limit ?? lines.length)).map((line) => ({ line }));
      },
    };
  };

  const volumeFile = (volumeId: string, path: string): string => {
    volumeFileCalls += 1;
    if (opts.filesApi === "unavailable") throw new SandboxError("files API unavailable", { statusCode: 400 });
    if (opts.filesApi === "timeout") throw new SandboxTimeoutError("request timed out after 30000ms");
    const vol = volumeById(volumeId);
    if (!vol) throw new NotFoundError(`fake porter: no volume ${volumeId}`);
    return join(vol.dir, path.replace(/^\/+/, ""));
  };

  const client: PorterClientLike = {
    sandboxes: {
      async create(spec) {
        if (bodies.has(spec.name!)) throw new Error("could not create sandbox: sandbox not running");
        const wanted = spec.networking?.[0]?.domains?.[0]?.domain;
        if (wanted && [...bodies.values()].some((b) => b.phase !== "terminated" && b.host === wanted)) {
          throw new Error(`fake porter: domain ${wanted} is held by a live sandbox`);
        }
        let snapshot: { sandboxId: string; dir: string } | undefined;
        if (spec.snapshot_id) {
          if (spec.image)
            throw new SandboxError("validation error: image must be empty when snapshot_id is set", {
              statusCode: 400,
            });
          snapshot = snapshots.get(spec.snapshot_id);
          if (!snapshot) throw new NotFoundError(`fake porter: no snapshot ${spec.snapshot_id}`);
        }
        const mounts: Record<string, string> = {};
        for (const [guest, volId] of Object.entries(spec.volume_mounts ?? {})) {
          const vol = volumeById(volId);
          if (!vol) throw new Error(`fake porter: unknown volume ${volId}`);
          const holder = [...bodies.values()].find(
            (b) => b.phase !== "terminated" && Object.values(b.mounts).includes(vol.dir),
          );
          if (holder) throw new Error(`fake porter: volume ${volId} is still attached to a ${holder.phase} sandbox`);
          mounts[guest] = vol.dir;
        }
        const homeVolumeId = spec.volume_mounts?.[GUEST_HOME];
        const home = mounts[GUEST_HOME] ?? join(root, `${spec.name}-home`);
        const app = join(root, `${spec.name}-app`);
        mkdirSync(home, { recursive: true });
        mkdirSync(app, { recursive: true });
        if (snapshot) cpSync(snapshot.dir, app, { recursive: true });
        const exposed = spec.networking?.[0];
        const named = opts.assignHost === false ? undefined : `${spec.name}.fake.test`;
        const host = exposed ? (exposed.domains?.[0]?.domain ?? named ?? "") : "";
        bodies.set(spec.name!, {
          id: `sb-${++bodySeq}`,
          phase: "running",
          terminatingTicks: 0,
          tags: { ...spec.tags, ...(homeVolumeId ? { "qm-volume-id": homeVolumeId } : {}) },
          image: spec.image,
          ...(spec.snapshot_id ? { snapshotId: spec.snapshot_id } : {}),
          ...(spec.resources ? { resources: spec.resources } : {}),
          home,
          app,
          tmp: join(root, `${spec.name}-tmp`),
          mounts,
          volumeMounts: { ...(spec.volume_mounts ?? {}) },
          host,
          startedAt: new Date().toISOString(),
          logs: ["sandbox started"],
          ...(spec.egress ? { egress: spec.egress.allowed_destinations } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.networking ? { networking: spec.networking } : {}),
        });
        return sandboxOf(spec.name!, false);
      },
      async get(name) {
        nameLookups += 1;
        if (!bodies.has(name)) throw new NotFoundError(`fake porter: no body ${name}`);
        return sandboxOf(name);
      },
      async byId(id) {
        const found = bodyById(id);
        if (!found) throw new NotFoundError(`fake porter: no sandbox ${id}`);
        observe(found[1]);
        return sandboxOf(found[0]);
      },
      async listPage(options) {
        listCalls += 1;
        const tags = options.tags ?? {};
        for (const b of bodies.values()) observe(b);
        const matching = [...bodies.keys()].filter((name) =>
          Object.entries(tags).every(([k, v]) => bodies.get(name)!.tags[k] === v),
        );
        const pageSize = opts.pageSize ?? Math.max(1, matching.length);
        const page = options.page;
        return {
          sandboxes: matching.slice((page - 1) * pageSize, page * pageSize).map((name) => sandboxOf(name)),
          hasNextPage: page * pageSize < matching.length,
        };
      },
      raw: {
        async get(id) {
          statusReads += 1;
          const found = bodyById(id);
          if (!found) throw new NotFoundError(`fake porter: no sandbox ${id}`);
          const [, cur] = found;
          observe(cur);
          return { phase: cur.phase, host: cur.host };
        },
        async exec(id, body, _options) {
          const found = bodyById(id);
          if (!found) throw new NotFoundError(`fake porter: no sandbox ${id}`);
          const [, cur] = found;
          if (cur.phase !== "running") throw new Error(`fake porter: exec on ${cur.phase} body`);
          const script = body.command[body.command.length - 1] ?? "";
          execScripts.push(script);
          mkdirSync(cur.tmp, { recursive: true });
          const child = spawn("sh", ["-c", remap(cur, script)], {
            env: { ...process.env, ...cur.env, COPYFILE_DISABLE: "1" },
          });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
          child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
          const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (c, s) => resolve([c, s]));
          });
          return {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exit_code: code ?? (sig ? 137 : -1),
          };
        },
      },
    },
    snapshots: {
      async create(sandboxId) {
        const found = bodyById(sandboxId);
        if (!found) throw new NotFoundError(`fake porter: no sandbox ${sandboxId}`);
        const [, cur] = found;
        if (cur.phase !== "running") throw new SandboxError("sandbox is not running", { statusCode: 409 });
        const id = `snap-${++snapshotSeq}`;
        if (opts.snapshotFails)
          return { id, sandbox_id: sandboxId, status: "failed", failure_reason: "capture aborted" };
        const dir = join(root, `${id}-fs`);
        mkdirSync(dir, { recursive: true });
        cpSync(cur.app, dir, { recursive: true });
        snapshots.set(id, { sandboxId, dir });
        return { id, sandbox_id: sandboxId, status: "ready", t_ready_unix_ms: Date.now() };
      },
      async delete(id) {
        const snap = snapshots.get(id);
        if (!snap) throw new NotFoundError(`fake porter: no snapshot ${id}`);
        rmSync(snap.dir, { recursive: true, force: true });
        snapshots.delete(id);
      },
    },
    volumes: {
      async create(body) {
        const name = body.name ?? `vol-anon-${++volumeSeq}`;
        let v = volumes.get(name);
        if (!v) {
          v = { id: `vol-${++volumeSeq}`, dir: join(root, `vol-${name}`) };
          mkdirSync(v.dir, { recursive: true });
          volumes.set(name, v);
        }
        return { id: v.id, attachedTo: attachedTo(v) };
      },
      async get(name) {
        const v = volumes.get(name);
        if (!v) throw new NotFoundError(`fake porter: no volume ${name}`);
        return { id: v.id, attachedTo: attachedTo(v) };
      },
      async delete(name) {
        const v = volumes.get(name);
        if (!v) return;
        if (attachedTo(v).length) throw new Error("volume is attached to a sandbox");
        rmSync(v.dir, { recursive: true, force: true });
        volumes.delete(name);
      },
      async readFile(volumeId, path, range) {
        const file = volumeFile(volumeId, path);
        if (!existsSync(file) || statSync(file).isDirectory()) throw new NotFoundError(`fake porter: no file ${path}`);
        const all = readFileSync(file);
        if (!range || all.length === 0) return { bytes: all, size: null };
        return { bytes: all.subarray(range.offset, range.offset + range.length), size: all.length };
      },
      async writeFile(volumeId, path, bytes) {
        const file = volumeFile(volumeId, path);
        mkdirSync(dirname(file), { recursive: true });
        const part = `${file}.${process.pid}.upload`;
        writeFileSync(part, bytes);
        renameSync(part, file);
      },
    },
  };

  return {
    client,
    bodies: () =>
      [...bodies.entries()].map(([name, b]) => ({
        name,
        id: b.id,
        phase: b.phase,
        tags: b.tags,
        host: b.host,
        image: b.image,
        ...(b.snapshotId ? { snapshotId: b.snapshotId } : {}),
        ...(b.resources ? { resources: b.resources } : {}),
        ...(b.egress ? { egress: b.egress } : {}),
        ...(b.env ? { env: b.env } : {}),
        ...(b.networking ? { networking: b.networking } : {}),
      })),
    hostOf: (name) => bodies.get(name)?.host ?? "",
    statusReads: () => statusReads,
    volumeDir: (volumeName) => {
      const v = volumes.get(volumeName);
      if (!v || !existsSync(v.dir)) throw new Error(`fake porter: no volume ${volumeName}`);
      return v.dir;
    },
    volumeNames: () => [...volumes.keys()],
    volumeFileCalls: () => volumeFileCalls,
    nameLookups: () => nameLookups,
    listCalls: () => listCalls,
    snapshots: () => [...snapshots.entries()].map(([id, s]) => ({ id, sandboxId: s.sandboxId })),
    terminateAll: () => {
      for (const [, b] of bodies) retire(b);
    },
    fail: (name, exitCode, logLines) => {
      const b = bodies.get(name);
      if (!b) throw new Error(`fake porter: no body ${name}`);
      killApp(b);
      b.phase = "failed";
      b.exitCode = exitCode;
      b.logs.push(...logLines);
    },
    execScripts: () => execScripts,
    cleanup: () => {
      for (const [, b] of bodies) killApp(b);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
