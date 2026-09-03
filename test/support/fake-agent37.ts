import { spawnSync } from "node:child_process";
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
  home: string;
}

export interface FakeInstanceView {
  status: string;
  template?: string;
  autoSleep?: boolean;
  resources?: Record<string, number>;
}

export interface FakeAgent37 {
  fetchImpl: typeof fetch;
  calls: Agent37Call[];
  names(): string[];
  instance(name: string): FakeInstanceView | null;
  sleep(name: string): void;
  execScripts(): string[];
  cleanup(): void;
}

export const FAKE_AGENT37_API_KEY = "sk_live_test_key";
const OUTPUT_CAP = 512 * 1024;

export function installFakeAgent37(): FakeAgent37 {
  const root = mkdtempSync(join(tmpdir(), "fake-a37-"));
  const instances = new Map<string, FakeInstance>();
  const execScripts: string[] = [];
  const calls: Agent37Call[] = [];
  let nextId = 1;

  const live = (): FakeInstance[] => [...instances.values()].filter((i) => i.status !== "deleted").reverse();
  const byName = (name: string): FakeInstance | undefined => live().find((i) => i.name === name);

  const create = (body: {
    name?: string | null;
    template?: string;
    auto_sleep?: boolean;
    resources?: Record<string, number>;
  }): FakeInstance => {
    const id = `inst${nextId++}`;
    const m: FakeInstance = {
      id,
      name: body.name ?? null,
      status: "provisioning",
      ...(body.template ? { template: body.template } : {}),
      ...(body.auto_sleep !== undefined ? { autoSleep: body.auto_sleep } : {}),
      ...(body.resources ? { resources: body.resources } : {}),
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
        .replace(/\btimeout \d+ /g, "")
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
    template: m.template ?? "agent37-qm-computer",
    resources: m.resources ?? {},
    name: m.name,
    auto_sleep: m.autoSleep === true,
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
    if (url.pathname === "/v1/instances" && method === "GET") {
      return Response.json({ data: live().map(info) });
    }
    if (url.pathname === "/v1/instances" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}");
      return Response.json(info(create(body)), { status: 201 });
    }
    const sub = /^\/v1\/instances\/([^/]+)(?:\/(exec|start|stop))?$/.exec(url.pathname);
    if (sub) {
      const m = instances.get(decodeURIComponent(sub[1]!));
      if (!m || m.status === "deleted") return error(404, "not_found", "Instance not found.");
      if (sub[2] === "exec") {
        if (m.status !== "running") {
          return error(400, "invalid_request", "Only running instances can execute commands.");
        }
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { command?: string };
        const script = body.command ?? "";
        calls[calls.length - 1]!.script = script;
        return runExec(m, script);
      }
      if (sub[2] === "start") {
        if (m.status === "running") return Response.json({ id: m.id, status: "running" });
        if (m.status !== "stopped" && m.status !== "sleeping") {
          return error(400, "invalid_request", "Only stopped or sleeping instances can be started.");
        }
        m.status = m.status === "sleeping" ? "waking" : "starting";
        return Response.json({ id: m.id, status: m.status });
      }
      if (sub[2] === "stop") {
        m.status = "stopped";
        return Response.json({ id: m.id, status: "stopped" });
      }
      if (method === "GET") return Response.json(info(settle(m)));
      if (method === "DELETE") {
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
          }
        : null;
    },
    sleep: (name) => {
      const m = byName(name);
      if (m) m.status = "sleeping";
    },
    execScripts: () => [...execScripts],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
