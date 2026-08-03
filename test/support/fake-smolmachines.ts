import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface SmolCall {
  method: string;
  path: string;
  script?: string;
}

interface FakeMachine {
  id: string;
  name: string | null;
  state: string;
  ephemeral: boolean;
  home: string;
}

export interface FakeSmolmachines {
  fetchImpl: typeof fetch;
  calls: SmolCall[];
  homeDir(name: string): string;
  names(): string[];
  machine(name: string): { state: string; ephemeral: boolean } | null;
  stop(name: string): void;
  execScripts(): string[];
  reset(): void;
  cleanup(): void;
}

export const FAKE_SMOLMACHINES_TOKEN = "test-token";

export function installFakeSmolmachines(): FakeSmolmachines {
  const root = mkdtempSync(join(tmpdir(), "fake-smol-"));
  const machines = new Map<string, FakeMachine>();
  const execScripts: string[] = [];
  const calls: SmolCall[] = [];
  let nextId = 1;

  const byName = (name: string): FakeMachine | undefined => [...machines.values()].find((m) => m.name === name);

  const create = (name: string | null, ephemeral: boolean): FakeMachine => {
    const id = `m-${nextId++}`;
    const m: FakeMachine = { id, name, state: "stopped", ephemeral, home: join(root, id) };
    mkdirSync(m.home, { recursive: true });
    machines.set(id, m);
    return m;
  };

  const remap = (m: FakeMachine, script: string): string => {
    const homeRe = m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(m.home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replace(/\/root/g, m.home)
        .replace(remapPath, (mm) => (mm.startsWith(m.home) ? mm : `${m.home}/tmp/`))
    );
  };

  const runExec = (m: FakeMachine, script: string, stdinB64?: string): Response => {
    execScripts.push(script);
    mkdirSync(join(m.home, "tmp"), { recursive: true });
    const r = spawnSync("sh", ["-c", remap(m, script)], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      ...(stdinB64 !== undefined ? { input: Buffer.from(stdinB64, "utf8") } : {}),
    });
    const code = r.status ?? (r.signal ? 137 : -1);
    const cap = 1024 * 1024;
    const stdout = (r.stdout ?? Buffer.alloc(0)).toString("utf8");
    const stderr = (r.stderr ?? Buffer.alloc(0)).toString("utf8");
    return Response.json({
      stdout: stdout.slice(0, cap),
      stderr: stderr.slice(0, cap),
      exitCode: code,
      durationMs: 1,
      machineId: m.id,
      stdoutTruncated: stdout.length > cap,
      stderrTruncated: stderr.length > cap,
    });
  };

  const info = (m: FakeMachine) => ({
    id: m.id,
    name: m.name,
    state: m.state,
    ephemeral: m.ephemeral,
    source: { type: "image", reference: "ubuntu:24.04" },
    resources: {},
    network: { mode: "open" },
    env: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });

  const toBuf = (body: unknown): Buffer => {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    return Buffer.alloc(0);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (url.pathname === "/v1/machines" && method === "GET") {
      return Response.json([...machines.values()].map(info));
    }
    if (url.pathname === "/v1/machines" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as {
        name?: string | null;
        ephemeral?: boolean;
      };
      if (body.name && byName(body.name)) return new Response("machine name conflict", { status: 409 });
      return Response.json(info(create(body.name ?? null, body.ephemeral ?? false)), { status: 201 });
    }
    const files = /^\/v1\/machines\/([^/]+)\/files(\/.+)$/.exec(url.pathname);
    if (files) {
      const m = machines.get(decodeURIComponent(files[1]!));
      if (!m) return new Response("machine not found", { status: 404 });
      const abs = files[2]!.split("/").map(decodeURIComponent).join("/");
      if (abs.startsWith("/tmp/")) return new Response("file not found", { status: 404 });
      const hostPath = abs.replace(/^\/root/, m.home);
      if (method === "PUT") {
        m.state = "Running";
        mkdirSync(dirname(hostPath), { recursive: true });
        writeFileSync(hostPath, toBuf(init?.body));
        return Response.json({ path: abs, size: toBuf(init?.body).length });
      }
      if (method === "GET") {
        if (!existsSync(hostPath)) return new Response("file not found", { status: 404 });
        return new Response(new Uint8Array(readFileSync(hostPath)), { status: 200 });
      }
    }
    const sub = /^\/v1\/machines\/([^/]+)(?:\/(exec|start|stop))?$/.exec(url.pathname);
    if (sub) {
      const m = machines.get(decodeURIComponent(sub[1]!));
      if (!m) return new Response("machine not found", { status: 404 });
      if (sub[2] === "exec") {
        if (m.state.toLowerCase() !== "running") return new Response("machine is stopped", { status: 409 });
        const body = JSON.parse(toBuf(init?.body).toString() || "{}") as {
          command?: string[] | string;
          stdin?: string;
        };
        const argv = Array.isArray(body.command) ? body.command : ["sh", "-c", body.command ?? ""];
        const script = argv[argv.length - 1] ?? "";
        calls[calls.length - 1]!.script = script;
        return runExec(m, script, body.stdin);
      }
      if (sub[2] === "start") {
        m.state = "Running";
        return Response.json(info(m));
      }
      if (sub[2] === "stop") {
        m.state = "stopped";
        return Response.json(info(m));
      }
      if (method === "GET") return Response.json(info(m));
      if (method === "DELETE") {
        rmSync(m.home, { recursive: true, force: true });
        machines.delete(m.id);
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    homeDir: (name) => (byName(name) ?? create(name, false)).home,
    names: () => [...machines.values()].map((m) => m.name ?? m.id),
    machine: (name) => {
      const m = byName(name);
      return m ? { state: m.state, ephemeral: m.ephemeral } : null;
    },
    stop: (name) => {
      const m = byName(name);
      if (m) m.state = "stopped";
    },
    execScripts: () => [...execScripts],
    reset: () => {
      for (const m of machines.values()) rmSync(m.home, { recursive: true, force: true });
      machines.clear();
      execScripts.length = 0;
      calls.length = 0;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
