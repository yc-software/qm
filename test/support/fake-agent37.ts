import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Agent37Call {
  method: string;
  host: string;
  path: string;
  script?: string;
}

interface FakeBackup {
  id: string;
  kind: "automatic" | "manual";
  created: number;
  size_bytes: number;
}

interface FakeInstance {
  id: string;
  name: string | null;
  user: string | null;
  metadata: Record<string, string> | null;
  status: string;
  template?: string;
  autoSleep?: boolean;
  idleTimeoutSeconds?: number;
  resources?: Record<string, number>;
  freezing?: number;
  backups: FakeBackup[];
  restarts: number;
  home: string;
}

export interface FakeInstanceView {
  id: string;
  status: string;
  name: string | null;
  user: string | null;
  metadata: Record<string, string> | null;
  template?: string;
  autoSleep?: boolean;
  idleTimeoutSeconds?: number;
  resources?: Record<string, number>;
  restarts: number;
  backups: FakeBackup[];
}

export interface FakeError {
  status: number;
  code: string;
  message?: string;
}

export interface FakeAgent37 {
  fetchImpl: typeof fetch;
  calls: Agent37Call[];
  names(): string[];
  instance(name: string): FakeInstanceView | null;
  sleep(name: string, opts?: { freezing?: number }): void;
  stop(name: string): void;
  fail(name: string): void;
  rename(name: string, next: string): void;
  addBackup(name: string, kind: "automatic" | "manual", createdSec: number): void;
  rejectNextCreate(...errors: FakeError[]): void;
  rejectNextExec(...errors: FakeError[]): void;
  setInstanceLimit(limit: number): void;
  execScripts(): string[];
  cleanup(): void;
}

export const FAKE_AGENT37_API_KEY = "sk_live_test_key";
const OUTPUT_CAP = 512 * 1024;
const MAX_NAME_LENGTH = 60;
const SHAPES: Record<number, { memory: number; disk: [number, number] }> = {
  2: { memory: 4, disk: [2, 12] },
  4: { memory: 8, disk: [2, 20] },
  8: { memory: 16, disk: [2, 40] },
};

export function installFakeAgent37(): FakeAgent37 {
  const root = mkdtempSync(join(tmpdir(), "fake-a37-"));
  const instances = new Map<string, FakeInstance>();
  const execScripts: string[] = [];
  const calls: Agent37Call[] = [];
  const createRejections: FakeError[] = [];
  const execRejections: FakeError[] = [];
  let instanceLimit = Number.POSITIVE_INFINITY;
  let nextId = 1;
  let nextBackup = 1;

  const live = (): FakeInstance[] => [...instances.values()].filter((i) => i.status !== "deleted").reverse();
  const byName = (name: string): FakeInstance | undefined => live().find((i) => i.name === name);

  const error = (status: number, code: string, message: string): Response =>
    Response.json({ error: { code, message } }, { status });
  const rejection = (e: FakeError): Response => error(e.status, e.code, e.message ?? e.code);

  const validShape = (r: Record<string, number> | undefined): boolean => {
    if (!r) return true;
    const shape = SHAPES[r.cpu ?? 2];
    if (!shape || shape.memory !== (r.memory ?? shape.memory)) return false;
    const disk = r.disk ?? shape.disk[0];
    return Number.isInteger(disk) && disk >= shape.disk[0] && disk <= shape.disk[1];
  };

  const create = (body: {
    name?: string | null;
    user?: string | null;
    metadata?: Record<string, string> | null;
    template?: string;
    auto_sleep?: boolean;
    idle_timeout_seconds?: number;
    resources?: Record<string, number>;
  }): FakeInstance => {
    const id = `inst${nextId++}`;
    const m: FakeInstance = {
      id,
      name: body.name ?? null,
      user: body.user ?? null,
      metadata: body.metadata ?? null,
      status: "provisioning",
      ...(body.template ? { template: body.template } : {}),
      ...(body.auto_sleep !== undefined ? { autoSleep: body.auto_sleep } : {}),
      ...(body.idle_timeout_seconds !== undefined ? { idleTimeoutSeconds: body.idle_timeout_seconds } : {}),
      ...(body.resources ? { resources: body.resources } : {}),
      backups: [],
      restarts: 0,
      home: join(root, id),
    };
    mkdirSync(m.home, { recursive: true });
    instances.set(id, m);
    return m;
  };

  const settle = (m: FakeInstance): FakeInstance => {
    if (["provisioning", "waking", "starting", "restarting", "updating"].includes(m.status)) m.status = "running";
    return m;
  };

  const guestPath = (m: FakeInstance, p: string): string => {
    if (p === m.home || p.startsWith(`${m.home}/`)) return p;
    if (p.startsWith("~/")) return join(m.home, p.slice(2));
    if (p === "/home/node" || p.startsWith("/home/node/")) return join(m.home, p.slice("/home/node".length));
    if (p.startsWith("/tmp/")) return join(m.home, "tmp", p.slice("/tmp/".length));
    return p;
  };

  const remap = (m: FakeInstance, script: string): string => {
    const homeRe = m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(m.home)}; ` +
      script
        .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
        .replace(/\/home\/node/g, m.home)
        .replace(remapPath, (mm) => (mm.startsWith(m.home) ? mm : `${m.home}/tmp/`))
    );
  };

  const runExec = (m: FakeInstance, script: string): Response => {
    execScripts.push(script);
    mkdirSync(join(m.home, "tmp"), { recursive: true });
    const r = spawnSync("sh", ["-c", remap(m, script)], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const code = r.status ?? (r.signal ? 137 : -1);
    const stdout = (r.stdout ?? Buffer.alloc(0)).toString("utf8");
    const stderr = (r.stderr ?? Buffer.alloc(0)).toString("utf8");
    return Response.json({
      exit_code: code,
      stdout: stdout.slice(0, OUTPUT_CAP),
      stderr: stderr.slice(0, OUTPUT_CAP),
      truncated: stdout.length > OUTPUT_CAP || stderr.length > OUTPUT_CAP,
    });
  };

  const info = (m: FakeInstance) => ({
    id: m.id,
    status: m.status,
    status_reason: null,
    template: m.template ?? "agent37-hermes",
    resources: m.resources ?? {},
    url: `https://${m.id}.agent37.app`,
    name: m.name,
    user: m.user,
    metadata: m.metadata,
    auto_sleep: m.autoSleep === true,
    idle_timeout_seconds: m.idleTimeoutSeconds ?? 900,
  });

  const toBuf = (body: unknown): Buffer => {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === "string") return Buffer.from(body);
    return Buffer.alloc(0);
  };

  const headerOf = (init: RequestInit | undefined, name: string): string | undefined => {
    const h = init?.headers;
    if (!h) return undefined;
    if (h instanceof Headers) return h.get(name) ?? undefined;
    if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1];
    return Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  };

  const instancePlane = (m: FakeInstance, method: string, url: URL, init?: RequestInit): Response => {
    if (headerOf(init, "x-agent37-key") !== FAKE_AGENT37_API_KEY) {
      return error(401, "invalid_api_key", "No credential.");
    }
    if (m.status === "sleeping") m.status = "running";
    if (m.status === "stopped" || m.status === "stopping") {
      return error(502, "container_unavailable", "The instance is not running. Start it and retry.");
    }
    if (url.pathname === "/v1/health") return Response.json({ ok: true, agent: "codex", healthy: true });
    if (url.pathname === "/v1/files/content") {
      const p = url.searchParams.get("path");
      if (!p) return error(400, "validation_error", "path is required");
      const local = guestPath(m, p);
      if (method === "GET") {
        let st;
        try {
          st = statSync(local);
        } catch (e) {
          void e;
          return error(404, "file_not_found", `No file at ${p}.`);
        }
        if (!st.isFile()) return error(400, "validation_error", "path is not a regular file");
        return new Response(readFileSync(local), { headers: { "content-type": "application/octet-stream" } });
      }
      if (method === "PUT") {
        mkdirSync(dirname(local), { recursive: true });
        const bytes = toBuf(init?.body);
        writeFileSync(local, bytes);
        return Response.json({
          name: p.split("/").pop(),
          path: p,
          type: "file",
          size: bytes.length,
          modified: Date.now(),
          hidden: false,
        });
      }
    }
    return error(404, "not_found", "Unknown route on the instance URL.");
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, host: url.host, path: url.pathname });
    if (url.host.endsWith(".agent37.app")) {
      const m = instances.get(url.host.split(".")[0]!);
      if (!m || m.status === "deleted" || m.status === "failed") return error(404, "not_found", "Unknown instance.");
      return instancePlane(m, method, url, init);
    }
    if (headerOf(init, "authorization") !== `Bearer ${FAKE_AGENT37_API_KEY}`) {
      return error(401, "invalid_api_key", "The sk_live_ Bearer key is missing.");
    }
    if (url.pathname === "/v1/instances" && method === "GET") {
      return Response.json({ data: live().map(info) });
    }
    if (url.pathname === "/v1/instances" && method === "POST") {
      const queued = createRejections.shift();
      if (queued) return rejection(queued);
      if (live().length >= instanceLimit) {
        return error(409, "instance_limit_reached", "The workspace is at its instance limit.");
      }
      const body = JSON.parse(toBuf(init?.body).toString() || "{}");
      if (typeof body.name === "string" && body.name.length > MAX_NAME_LENGTH) {
        return error(400, "invalid_request", `name must be at most ${MAX_NAME_LENGTH} characters.`);
      }
      if (!validShape(body.resources)) {
        return error(400, "invalid_request", "Unsupported resource shape; valid shapes are 2/4, 4/8, 8/16.");
      }
      if (typeof body.template === "string" && body.template.endsWith("@latest")) {
        return error(400, "invalid_request", "@latest is not a published version.");
      }
      if (
        body.idle_timeout_seconds !== undefined &&
        (!Number.isInteger(body.idle_timeout_seconds) ||
          body.idle_timeout_seconds < 300 ||
          body.idle_timeout_seconds > 86_400)
      ) {
        return error(400, "invalid_request", "idle_timeout_seconds must be an integer from 300 to 86400.");
      }
      return Response.json(info(create(body)), { status: 201 });
    }
    const sub = /^\/v1\/instances\/([^/]+)(?:\/(exec|start|stop|restart|backups|restore))?$/.exec(url.pathname);
    if (sub) {
      const m = instances.get(decodeURIComponent(sub[1]!));
      if (!m || m.status === "deleted") return error(404, "not_found", "Instance not found.");
      if (sub[2] === "exec") {
        const queued = execRejections.shift();
        if (queued) return rejection(queued);
        if (m.status === "sleeping") {
          if (m.freezing) {
            m.freezing--;
            return error(409, "try_again", "A sleep checkpoint is in flight. Retry in a few seconds.");
          }
          m.status = "running";
        }
        if (m.status !== "running") {
          return error(400, "invalid_request", `Cannot exec on an instance that is ${m.status}.`);
        }
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { command?: string };
        const script = body.command ?? "";
        calls[calls.length - 1]!.script = script;
        return runExec(m, script);
      }
      if (sub[2] === "start") {
        if (m.status === "running") return Response.json({ id: m.id, status: "running" });
        if (m.freezing) {
          m.freezing--;
          return error(409, "try_again", "A sleep checkpoint is in flight. Retry in a few seconds.");
        }
        if (m.status !== "stopped" && m.status !== "sleeping") {
          return error(400, "invalid_request", "Only stopped or sleeping instances can be started.");
        }
        m.status = m.status === "sleeping" ? "waking" : "starting";
        return Response.json({ id: m.id, status: m.status });
      }
      if (sub[2] === "stop") {
        m.status = "stopping";
        return Response.json({ id: m.id, status: "stopping" });
      }
      if (sub[2] === "restart") {
        if (m.status !== "running") return error(400, "invalid_request", "The instance must be running.");
        m.restarts++;
        m.status = "restarting";
        return Response.json({ id: m.id, status: "running" });
      }
      if (sub[2] === "backups") {
        if (method === "GET") return Response.json({ data: [...m.backups].sort((a, b) => b.created - a.created) });
        if (method === "POST") {
          const record: FakeBackup = {
            id: `bk${nextBackup++}`,
            kind: "manual",
            created: Math.floor(Date.now() / 1000),
            size_bytes: 1024,
          };
          m.backups = [...m.backups.filter((b) => b.kind !== "manual"), record];
          return Response.json(record, { status: 201 });
        }
      }
      if (sub[2] === "restore") {
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { backup?: string };
        if (!m.backups.some((b) => b.id === body.backup)) return error(404, "not_found", "No such backup.");
        return Response.json({ id: m.id, status: m.status });
      }
      if (sub[2] === undefined && method === "PATCH") {
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as Partial<{
          name: string | null;
          user: string | null;
          metadata: Record<string, string> | null;
          auto_sleep: boolean;
          idle_timeout_seconds: number;
        }>;
        if (!Object.keys(body).length) return error(400, "invalid_request", "Send at least one field.");
        if (body.name !== undefined) m.name = body.name || null;
        if (body.user !== undefined) m.user = body.user || null;
        if (body.metadata !== undefined)
          m.metadata = body.metadata && Object.keys(body.metadata).length ? body.metadata : null;
        if (body.auto_sleep !== undefined) m.autoSleep = body.auto_sleep;
        if (body.idle_timeout_seconds !== undefined) m.idleTimeoutSeconds = body.idle_timeout_seconds;
        return Response.json(info(m));
      }
      if (sub[2] === undefined && method === "GET") {
        const body = info(settle(m));
        if (m.status === "stopping") m.status = "stopped";
        return Response.json(body);
      }
      if (sub[2] === undefined && method === "DELETE") {
        rmSync(m.home, { recursive: true, force: true });
        m.status = "deleted";
        return Response.json({ id: m.id, deleted: true });
      }
    }
    return error(404, "not_found", "No such endpoint.");
  };

  const view = (m: FakeInstance): FakeInstanceView => ({
    id: m.id,
    status: m.status,
    name: m.name,
    user: m.user,
    metadata: m.metadata,
    ...(m.template ? { template: m.template } : {}),
    ...(m.autoSleep !== undefined ? { autoSleep: m.autoSleep } : {}),
    ...(m.idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds: m.idleTimeoutSeconds } : {}),
    ...(m.resources ? { resources: m.resources } : {}),
    restarts: m.restarts,
    backups: [...m.backups],
  });

  return {
    fetchImpl,
    calls,
    names: () => live().map((m) => m.name ?? m.id),
    instance: (name) => {
      const m = byName(name);
      return m ? view(m) : null;
    },
    sleep: (name, opts) => {
      const m = byName(name);
      if (m) {
        m.status = "sleeping";
        m.freezing = opts?.freezing ?? 0;
      }
    },
    stop: (name) => {
      const m = byName(name);
      if (m) m.status = "stopping";
    },
    fail: (name) => {
      const m = byName(name);
      if (m) m.status = "failed";
    },
    rename: (name, next) => {
      const m = byName(name);
      if (m) m.name = next;
    },
    addBackup: (name, kind, createdSec) => {
      const m = byName(name);
      if (m) m.backups.push({ id: `bk${nextBackup++}`, kind, created: createdSec, size_bytes: 2048 });
    },
    rejectNextCreate: (...errors) => {
      createRejections.push(...errors);
    },
    rejectNextExec: (...errors) => {
      execRejections.push(...errors);
    },
    setInstanceLimit: (limit) => {
      instanceLimit = limit;
    },
    execScripts: () => [...execScripts],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
