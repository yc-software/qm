import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Agent37Call {
  method: string;
  path: string;
  script?: string;
}

interface FakeInstance {
  id: string;
  name: string | null;
  status: string;
  template?: string;
  autoSleep?: boolean;
  resources?: Record<string, number>;
  publicPorts?: number[];
  metadata?: Record<string, unknown>;
  process?: ChildProcess;
  freezing?: number;
  home: string;
}

export interface InjectedFailure {
  headers?: Record<string, string>;
  body?: string;
  match?: (call: { method: string; path: string }) => boolean;
}

export interface FakeInstanceView {
  status: string;
  template?: string;
  autoSleep?: boolean;
  resources?: Record<string, number>;
  publicPorts?: number[];
}

export interface FakeTemplate {
  name: string;
  image_ref?: string;
  default_port?: number | null;
  entrypoint?: string[];
  revision?: number;
}

export interface FakeAgent37 {
  fetchImpl: typeof fetch;
  calls: Agent37Call[];
  names(): string[];
  instance(name: string): FakeInstanceView | null;
  sleep(name: string, opts?: { freezing?: number }): void;
  stop(name: string): void;
  fail(name: string): void;
  failNext(status: number, opts?: InjectedFailure): void;
  execScripts(): string[];
  templates(): FakeTemplate[];
  cleanup(): void;
}

export const FAKE_AGENT37_API_KEY = "sk_live_test_key";
const OUTPUT_CAP = 512 * 1024;

export function installFakeAgent37(): FakeAgent37 {
  const root = mkdtempSync(join(tmpdir(), "fake-a37-"));
  const instances = new Map<string, FakeInstance>();
  const templates = new Map<string, FakeTemplate>();
  const execScripts: string[] = [];
  const calls: Agent37Call[] = [];
  let nextId = 1;
  const injected: Array<InjectedFailure & { status: number }> = [];

  const live = (): FakeInstance[] => [...instances.values()].filter((i) => i.status !== "deleted").reverse();
  const byName = (name: string): FakeInstance | undefined => live().find((i) => i.name === name);

  const create = (body: {
    name?: string | null;
    template?: string;
    auto_sleep?: boolean;
    resources?: Record<string, number>;
    public_ports?: Array<{ port: number }>;
    metadata?: Record<string, unknown>;
  }): FakeInstance => {
    const id = `inst${nextId++}`;
    const m: FakeInstance = {
      id,
      name: body.name ?? null,
      status: "provisioning",
      ...(body.template ? { template: body.template } : {}),
      ...(body.auto_sleep !== undefined ? { autoSleep: body.auto_sleep } : {}),
      ...(body.resources ? { resources: body.resources } : {}),
      ...(body.public_ports?.length ? { publicPorts: body.public_ports.map((p) => p.port) } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      home: join(root, id),
    };
    mkdirSync(m.home, { recursive: true });
    instances.set(id, m);
    return m;
  };

  const settle = (m: FakeInstance): FakeInstance => {
    if (m.status === "provisioning" || m.status === "waking" || m.status === "starting") m.status = "running";
    return m;
  };

  const remap = (m: FakeInstance, script: string): string => {
    const homeRe = m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(m.home)}; ` +
      script
        .replace(/\btimeout (?:-k \d+ )?\d+ /g, "")
        .replace(/\/home\/node/g, m.home)
        .replace(/\/(app|data)(?![A-Za-z0-9._-])/g, `${m.home}/$1`)
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

  const boot = (m: FakeInstance) => {
    const entrypoint = templates.get(m.template ?? "")?.entrypoint;
    if (!entrypoint) return;
    mkdirSync(join(m.home, "tmp"), { recursive: true });
    m.process = spawn(entrypoint[0]!, [...entrypoint.slice(1, -1), remap(m, entrypoint.at(-1)!)], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
  };

  const stopProcess = async (m: FakeInstance) => {
    const child = m.process;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    process.kill(-child.pid, "SIGKILL");
    await stopped;
    delete m.process;
  };

  const info = (m: FakeInstance) => ({
    id: m.id,
    status: m.status,
    template: m.template ?? "agent37-codex",
    resources: m.resources ?? {},
    name: m.name,
    auto_sleep: m.autoSleep === true,
    metadata: m.metadata ?? {},
    url: `https://${m.id}.agent37.app`,
    public_ports: (m.publicPorts ?? []).map((port) => ({ port, url: `https://pp-${m.id}-${port}.agent37.app` })),
  });

  const error = (status: number, code: string, message: string): Response =>
    Response.json({ error: { code, message } }, { status });

  const toBuf = (body: unknown): Buffer => {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    return Buffer.alloc(0);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const at = injected.findIndex((f) => !f.match || f.match({ method, path: url.pathname }));
    if (at >= 0) {
      const [next] = injected.splice(at, 1);
      return new Response(next!.body ?? `injected ${next!.status}`, {
        status: next!.status,
        headers: next!.headers ?? {},
      });
    }
    const tpl = /^\/v1\/templates\/([^/]+)$/.exec(url.pathname);
    if (tpl) {
      const found = templates.get(decodeURIComponent(tpl[1]!));
      return found ? Response.json(found) : error(404, "not_found", "Template not found.");
    }
    if (url.pathname === "/v1/templates" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as FakeTemplate;
      if (templates.has(body.name)) return error(409, "template_conflict", "Template already exists.");
      templates.set(body.name, { ...body, revision: 1 });
      return Response.json(templates.get(body.name), { status: 201 });
    }
    if (url.pathname === "/v1/instances" && method === "GET") {
      return Response.json({ data: live().map(info) });
    }
    if (url.pathname === "/v1/instances" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}");
      const m = create(body);
      boot(m);
      return Response.json(info(m), { status: 201 });
    }
    const sub = /^\/v1\/instances\/([^/]+)(?:\/(exec|start|stop|restart))?$/.exec(url.pathname);
    if (sub) {
      const m = instances.get(decodeURIComponent(sub[1]!));
      if (!m || m.status === "deleted") return error(404, "not_found", "Instance not found.");
      if (sub[2] === "exec") {
        if (m.status === "sleeping") {
          if (m.freezing) {
            m.freezing--;
            return error(409, "try_again", "A sleep checkpoint is in flight. Retry in a few seconds.");
          }
          m.status = "running";
        }
        if (m.status !== "running") {
          return error(
            400,
            "invalid_request",
            "Only running instances can execute commands (a sleeping instance is woken first).",
          );
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
        await stopProcess(m);
        m.status = "stopping";
        return Response.json({ id: m.id, status: "stopping" });
      }
      if (sub[2] === "restart") {
        await stopProcess(m);
        boot(m);
        m.status = "starting";
        return Response.json({ id: m.id, status: m.status });
      }
      if (method === "PATCH") {
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { auto_sleep?: boolean };
        if (body.auto_sleep !== undefined) m.autoSleep = body.auto_sleep;
        return Response.json(info(m));
      }
      if (method === "GET") {
        const body = info(settle(m));
        if (m.status === "stopping") m.status = "stopped";
        return Response.json(body);
      }
      if (method === "DELETE") {
        await stopProcess(m);
        rmSync(m.home, { recursive: true, force: true });
        m.status = "deleted";
        return Response.json({ id: m.id, deleted: true });
      }
    }
    return error(404, "not_found", "No such endpoint.");
  };

  return {
    fetchImpl,
    calls,
    names: () => live().map((m) => m.name ?? m.id),
    instance: (name) => {
      const m = byName(name);
      return m
        ? {
            status: m.status,
            ...(m.template ? { template: m.template } : {}),
            ...(m.autoSleep !== undefined ? { autoSleep: m.autoSleep } : {}),
            ...(m.resources ? { resources: m.resources } : {}),
            ...(m.publicPorts ? { publicPorts: m.publicPorts } : {}),
          }
        : null;
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
    failNext: (status, opts = {}) => {
      injected.push({ status, ...opts });
    },
    execScripts: () => [...execScripts],
    templates: () => [...templates.values()],
    cleanup: () => {
      for (const instance of instances.values()) {
        const child = instance.process;
        if (child?.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
