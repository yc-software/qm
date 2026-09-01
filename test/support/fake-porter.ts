import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError } from "porter-sandbox";
import type { PorterClientLike, PorterSandboxLike, PorterSandboxSpec } from "../../src/sandbox/porter-client.ts";

export interface FakePorterBody {
  name: string;
  phase: string;
  tags: Record<string, string>;
  host: string;
  egress?: string[];
  env?: Record<string, string>;
  networking?: PorterSandboxSpec["networking"];
}

export interface FakePorterOptions {
  terminateLag?: number;
  pageSize?: number;
}

export interface FakePorter {
  client: PorterClientLike;
  bodies(): FakePorterBody[];
  hostOf(name: string): string;
  statusReads(): number;
  volumeDir(volumeName: string): string;
  volumeNames(): string[];
  terminateAll(): void;
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
  home: string;
  app: string;
  tmp: string;
  mounts: Record<string, string>;
  host: string;
  egress?: string[];
  env?: Record<string, string>;
  networking?: PorterSandboxSpec["networking"];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathRe = (guestPath: string): RegExp => new RegExp(`${escapeRe(guestPath)}(?![A-Za-z0-9._-])`, "g");

export function installFakePorter(opts: FakePorterOptions = {}): FakePorter {
  const root = mkdtempSync(join(tmpdir(), "fake-porter-"));
  const volumes = new Map<string, { id: string; dir: string }>();
  const bodies = new Map<string, BodyRecord>();
  const execScripts: string[] = [];
  let volumeSeq = 0;
  let bodySeq = 0;
  let statusReads = 0;

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

  const remap = (b: BodyRecord, script: string): string => {
    const remapTmp = new RegExp(`${escapeRe(b.home)}/tmp/|/tmp/`, "g");
    let out = script
      .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
      .replace(pathRe(GUEST_HOME), b.home)
      .replace(pathRe(GUEST_APP), b.app);
    for (const [guest, dir] of Object.entries(b.mounts))
      if (guest !== GUEST_HOME) out = out.replace(pathRe(guest), dir);
    out = out.replace(remapTmp, `${b.tmp}/`);
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
        return { name, host: observe(bodies.get(name))?.host ?? "" };
      },
      async terminate() {
        const cur = bodies.get(name);
        if (cur) retire(cur);
      },
    };
  };

  const client: PorterClientLike = {
    sandboxes: {
      async create(spec) {
        if (bodies.has(spec.name!)) throw new Error("could not create sandbox: sandbox not running");
        const wanted = spec.networking?.[0]?.domains?.[0]?.domain;
        if (wanted && [...bodies.values()].some((b) => b.phase !== "terminated" && b.host === wanted)) {
          throw new Error(`fake porter: domain ${wanted} is held by a live sandbox`);
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
        const exposed = spec.networking?.[0];
        const host = exposed ? (exposed.domains?.[0]?.domain ?? `${spec.name}.fake.test`) : "";
        bodies.set(spec.name!, {
          id: `sb-${++bodySeq}`,
          phase: "running",
          terminatingTicks: 0,
          tags: { ...spec.tags, ...(homeVolumeId ? { "qm-volume-id": homeVolumeId } : {}) },
          home,
          app,
          tmp: join(root, `${spec.name}-tmp`),
          mounts,
          host,
          ...(spec.egress ? { egress: spec.egress.allowed_destinations } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.networking ? { networking: spec.networking } : {}),
        });
        return sandboxOf(spec.name!, false);
      },
      async get(name) {
        if (!bodies.has(name)) throw new NotFoundError(`fake porter: no body ${name}`);
        return sandboxOf(name);
      },
      async list(options) {
        const tags = options?.tags ?? {};
        for (const b of bodies.values()) observe(b);
        const matching = [...bodies.keys()].filter((name) =>
          Object.entries(tags).every(([k, v]) => bodies.get(name)!.tags[k] === v),
        );
        const pageSize = opts.pageSize ?? matching.length;
        const page = options?.page ?? 1;
        return matching.slice((page - 1) * pageSize, page * pageSize).map((name) => sandboxOf(name));
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
          const r = spawnSync("sh", ["-c", remap(cur, script)], {
            encoding: "buffer",
            maxBuffer: 128 * 1024 * 1024,
            env: { ...process.env, ...cur.env, COPYFILE_DISABLE: "1" },
          });
          return {
            stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
            stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
            exit_code: r.status ?? (r.signal ? 137 : -1),
          };
        },
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
        return { id: v.id };
      },
      async get(name) {
        const v = volumes.get(name);
        if (!v) throw new NotFoundError(`fake porter: no volume ${name}`);
        return { id: v.id };
      },
      async delete(name) {
        const v = volumes.get(name);
        if (!v) return;
        const attached = [...bodies.values()].some(
          (b) => b.phase !== "terminated" && Object.values(b.mounts).includes(v.dir),
        );
        if (attached) throw new Error("volume is attached to a sandbox");
        rmSync(v.dir, { recursive: true, force: true });
        volumes.delete(name);
      },
    },
  };

  return {
    client,
    bodies: () =>
      [...bodies.entries()].map(([name, b]) => ({
        name,
        phase: b.phase,
        tags: b.tags,
        host: b.host,
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
    terminateAll: () => {
      for (const [, b] of bodies) retire(b);
    },
    execScripts: () => execScripts,
    cleanup: () => {
      for (const [, b] of bodies) killApp(b);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
