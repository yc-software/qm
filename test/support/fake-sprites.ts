import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCRIPT_RUNNER } from "../../src/sandbox/sprites-sandbox.ts";

export interface NetworkRule {
  domain: string;
  action: string;
}

export interface SpritesCall {
  method: string;
  path: string;
  script?: string;
}

export interface InjectedFailure {
  headers?: Record<string, string>;
  match?: (call: { method: string; path: string }) => boolean;
}

export interface FakeSprites {
  baseUrl: string;
  calls: SpritesCall[];
  homeDir(name: string): string;
  names(): string[];
  policy(name: string): NetworkRule[] | null;
  resources(name: string): { limitMB: number } | null;
  checkpoints(name: string): string[];
  execScripts(): string[];
  stallAfterRun(name: string): void;
  fail502(name: string): void;
  failNext(status: number, opts?: InjectedFailure): void;
  refuseRestart(name: string): void;
  unhealthy(name: string, reason: string): void;
  health(name: string, status: string, reason: string): void;
  refuseDelete(status?: number): void;
  rateLimitCreate(retryAfterSeconds: number): void;
  breakPolicyReadback(name: string): void;
  setPressure(name: string, p: { full10: number; full60: number; load1: number }): void;
  restarts(): string[];
  reset(): void;
  cleanup(): void;
}

const TOKEN = "test-token";
const API_ORIGIN = "https://api.sprites.dev";
const GUEST_HOME = "/home/sprite";

interface Engine {
  fetch(url: URL, init?: RequestInit): Promise<Response>;
  exec(url: URL): FakeExec | null;
}

interface FakeExec {
  run(stdin: Buffer): Promise<{ frames: Buffer[]; dropAfterRun: boolean }>;
  refused: boolean;
}

const engines = new Map<string, Engine>();
let nextOrigin = 0;
let routerInstalled = false;

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  private readonly stdin: Buffer[] = [];
  private closed = false;

  private readonly exec: FakeExec;

  constructor(url: string, exec: FakeExec) {
    super();
    void url;
    this.exec = exec;
    setImmediate(() => {
      if (this.closed) return;
      if (exec.refused) {
        this.fail("Received network error or non-101 status code.");
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: Buffer | string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("fake websocket is not open");
    if (typeof data === "string") return;
    const frame = Buffer.from(data);
    if (frame[0] === 0) this.stdin.push(frame.subarray(1));
    if (frame[0] !== 4) return;
    void this.exec
      .run(Buffer.concat(this.stdin))
      .then(({ frames, dropAfterRun }) => {
        if (this.closed) return;
        if (dropAfterRun) {
          this.fail("connection reset by peer");
          return;
        }
        for (const f of frames) this.dispatchEvent(new MessageEvent("message", { data: toArrayBuffer(f) }));
        this.finish(1000, "");
      })
      .catch((error) => this.fail(String(error)));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.readyState = FakeWebSocket.CLOSING;
    setImmediate(() => this.finish(code, reason));
  }

  private fail(message: string): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message, error: new Error(message) }));
    this.finish(1006, "");
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

function installRouter(): void {
  if (routerInstalled) return;
  routerInstalled = true;
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const patchedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const engine = engines.get(url.origin);
    return engine ? engine.fetch(url, init) : realFetch(input, init);
  };
  (globalThis as { fetch: typeof fetch }).fetch = patchedFetch;
  const Patched = function (this: unknown, url: string | URL, options?: unknown) {
    const parsed = new URL(String(url));
    const origin = parsed.origin.replace(/^ws/, "http");
    const exec = engines.get(origin)?.exec(parsed);
    if (exec) return new FakeWebSocket(parsed.href, exec);
    return new RealWebSocket(url, options as never);
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = Patched;
}

export function installFakeSprites(origin = `https://fake-sprites-${++nextOrigin}.invalid`): FakeSprites {
  installRouter();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fake-sprites-")));
  const sprites = new Map<string, { home: string; id: string; created_at: string }>();
  const policies = new Map<string, NetworkRule[]>();
  const resources = new Map<string, { limitMB: number }>();
  const checkpoints = new Map<string, Array<{ id: string; createTime: string; dir: string }>>();
  const execScripts: string[] = [];
  const calls: SpritesCall[] = [];
  const gateway502 = new Set<string>();
  const stallAfterRun = new Set<string>();
  const refusedRestart = new Set<string>();
  const unhealthy = new Map<string, string>();
  const health = new Map<string, { status: string; reason: string }>();
  const brokenReadback = new Set<string>();
  const restarts: string[] = [];
  let refuseDeleteStatus: number | undefined;
  let rateLimitRetryAfter: number | undefined;
  let checkpointSeq = 0;
  const injected: Array<InjectedFailure & { status: number }> = [];

  const ensureDir = (name: string): string => {
    let s = sprites.get(name);
    if (!s) {
      s = { id: randomUUID(), created_at: new Date().toISOString(), home: join(root, name) };
      mkdirSync(s.home, { recursive: true });
      sprites.set(name, s);
    }
    return s.home;
  };

  const hostPath = (name: string, abs: string): string => {
    const home = ensureDir(name);
    if (abs.startsWith(`${root}/`)) return abs;
    if (abs === GUEST_HOME || abs.startsWith(`${GUEST_HOME}/`)) return home + abs.slice(GUEST_HOME.length);
    if (abs.startsWith("/tmp/")) return join(home, "tmp", abs.slice(5));
    if (abs.startsWith("/usr/local/")) return join(home, ".usr-local", abs.slice("/usr/local/".length));
    return join(home, abs);
  };

  const remap = (name: string, script: string): string => {
    const home = ensureDir(name);
    const homeRe = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replace(/exec setsid sh/g, "exec sh")
        .replace(/\bsha256sum -c --status\b/g, "shasum -a 256 -c --status")
        .replace(/\/proc\/pressure\/io/g, `${home}/.proc-pressure-io`)
        .replace(/\/proc\/loadavg/g, `${home}/.proc-loadavg`)
        .replace(/\/usr\/local/g, `${home}/.usr-local`)
        .replace(/\/opt\/qm-supervisor/g, `${home}/opt/qm-supervisor`)
        .replace(/\/dev\/shm\/qm-supervisor/g, `${home}/dev/shm/qm-supervisor`)
        .replace(/\/home\/sprite/g, home)
        .replace(remapPath, (m) => (m.startsWith(home) ? m : `${home}/tmp/`))
    );
  };

  const toBuf = (body: unknown): Buffer => {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === "string") return Buffer.from(body);
    return Buffer.alloc(0);
  };

  const fakeSupervisorData = (name: string, path: string, data: Buffer): Buffer => {
    if (path.startsWith("/opt/qm-supervisor/execution-supervisor.py.")) {
      return readFileSync(new URL("./fake-execution-supervisor.py", import.meta.url));
    }
    if (path.startsWith("/dev/shm/qm-supervisor/") && path.endsWith(".json")) {
      const request = JSON.parse(data.toString());
      if (
        typeof request.command !== "string" ||
        typeof request.workspace !== "string" ||
        typeof request.cwd !== "string" ||
        typeof request.env !== "object" ||
        !Array.isArray(request.files)
      ) {
        throw new Error("Invalid fake supervisor request");
      }
      execScripts.push(request.command);
      const remapped = remap(name, request.command);
      request.command = remapped.slice(remapped.indexOf("; ") + 2);
      request.workspace = hostPath(name, request.workspace);
      request.cwd = hostPath(name, request.cwd);
      return Buffer.from(JSON.stringify(request));
    }
    return data;
  };

  const runExec = async (name: string, argv: string[], stdin: Buffer): Promise<Buffer[]> => {
    mkdirSync(join(ensureDir(name), "tmp"), { recursive: true });
    const viaBody = argv[argv.length - 1] === SCRIPT_RUNNER;
    const script = viaBody ? stdin.toString("utf8") : (argv[argv.length - 1] ?? "");
    execScripts.push(script);
    if (script.includes("/.sprite/api.sock") && script.includes("/run/qm-supervisor/processes")) {
      return [Buffer.concat([Buffer.from([1]), Buffer.from("OK\n")]), Buffer.from([2]), Buffer.from([3, 0])];
    }
    if (
      script.includes("command -v bwrap && command -v setpriv") ||
      (script.includes("probe()") && script.includes("libseccomp.so.2")) ||
      script.includes("os.chown(path,-1,61001") ||
      ((script.includes("sleep 60; rm -f") || script.includes("sleep 300; rm -f")) && script.includes("qm-supervisor/"))
    ) {
      return [Buffer.from([1]), Buffer.from([2]), Buffer.from([3, 0])];
    }
    if (script.includes("sha256sum /opt/qm-supervisor/execution-supervisor.py")) {
      return [
        Buffer.from([1]),
        Buffer.from([2]),
        Buffer.from([3, existsSync(hostPath(name, "/opt/qm-supervisor/execution-supervisor.py")) ? 0 : 1]),
      ];
    }
    if (argv[0] === "sudo" && argv.includes("python3") && argv.some((arg) => arg.includes("os.O_EXCL"))) {
      const target = hostPath(name, argv.at(-1)!);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, stdin);
      return [Buffer.from([1]), Buffer.from([2]), Buffer.from([3, 0])];
    }
    if (script.includes("assert os.geteuid()==0") && script.includes("target.parent.stat()")) {
      const path = /'(\/(?:opt|run|dev\/shm)\/qm-supervisor\/[^']+)'\s*$/.exec(script)?.[1];
      if (!path) throw new Error("Invalid fake supervisor staging path");
      mkdirSync(dirname(hostPath(name, path)), { recursive: true });
      return [Buffer.from([1]), Buffer.from([2]), Buffer.from([3, 0])];
    }
    if (script.includes("source,target=sys.argv[1:]") && script.includes("os.replace(source,target)")) {
      const paths =
        /'(\/(?:opt|run|dev\/shm)\/qm-supervisor\/[^']+)' '(\/(?:opt|run|dev\/shm)\/qm-supervisor\/[^']+)'\s*$/.exec(
          script,
        );
      if (!paths) throw new Error("Invalid fake supervisor commit paths");
      const source = hostPath(name, paths[1]!);
      const target = hostPath(name, paths[2]!);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, fakeSupervisorData(name, paths[2]!, readFileSync(source)));
      rmSync(source);
      return [Buffer.from([1]), Buffer.from([2]), Buffer.from([3, 0])];
    }
    const r = await new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>((resolve) => {
      const child = execFile(
        "sh",
        ["-c", viaBody ? SCRIPT_RUNNER : remap(name, script)],
        {
          encoding: "buffer",
          maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) code = typeof error.code === "number" ? error.code : 137;
          resolve({ stdout, stderr, code });
        },
      );
      child.stdin!.end(viaBody ? Buffer.from(remap(name, script), "utf8") : stdin);
    });
    const code = r.code;
    const frame = (id: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([id]), payload]);
    return [
      frame(1, r.stdout ?? Buffer.alloc(0)),
      frame(2, r.stderr ?? Buffer.alloc(0)),
      Buffer.from([3, code & 0xff]),
    ];
  };

  const deleteSprite = (name: string): void => {
    const s = sprites.get(name);
    if (s) rmSync(s.home, { recursive: true, force: true });
    for (const cp of checkpoints.get(name) ?? []) rmSync(cp.dir, { recursive: true, force: true });
    sprites.delete(name);
    policies.delete(name);
    resources.delete(name);
    checkpoints.delete(name);
  };

  const ndjson = (lines: object[]): Response =>
    new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  const fsResult = (path: string, op: () => object): Response => {
    try {
      return Response.json(op());
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return Response.json({ error: err.message ?? "filesystem error", code: err.code, path }, { status: 500 });
    }
  };
  const notFound = (what: string): Response =>
    Response.json({ error: "not_found", message: `${what} not found` }, { status: 404 });

  const fetchImpl = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search });
    const at = injected.findIndex((f) => !f.match || f.match({ method, path: url.pathname }));
    if (at >= 0) {
      const [next] = injected.splice(at, 1);
      return Response.json(
        { error: "injected", message: `injected ${next!.status}` },
        { status: next!.status, headers: next!.headers },
      );
    }
    const one = /^\/v1\/sprites\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (url.pathname === "/v1/sprites" && method === "POST") {
      if (rateLimitRetryAfter !== undefined) {
        const retry = rateLimitRetryAfter;
        rateLimitRetryAfter = undefined;
        return Response.json(
          {
            error: "sprite_creation_rate_limited",
            message: "Sprite creation rate limit exceeded",
            limit: 10,
            window_seconds: 60,
            retry_after_seconds: retry,
          },
          { status: 429, headers: { "retry-after": String(retry) } },
        );
      }
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { name?: string };
      const name = body.name ?? "unnamed";
      ensureDir(name);
      return Response.json({ name, ...sprites.get(name), status: "running" });
    }
    if (!one) return notFound("route");
    const name = decodeURIComponent(one[1]!);
    const sub = one[2] ?? "";
    if (!sub) {
      if (method === "GET")
        return sprites.has(name) ? Response.json({ name, ...sprites.get(name), status: "warm" }) : notFound("sprite");
      if (method === "DELETE") {
        if (refuseDeleteStatus !== undefined)
          return Response.json({ error: "upstream" }, { status: refuseDeleteStatus });
        if (!sprites.has(name)) return notFound("sprite");
        deleteSprite(name);
        return new Response(null, { status: 204 });
      }
      return notFound("route");
    }
    if (!sprites.has(name)) return notFound("sprite");
    if (sub === "check") {
      const reason = unhealthy.get(name);
      return Response.json({
        sprite_name: name,
        sprite_id: `id-${name}`,
        status: health.get(name)?.status ?? (reason ? "unhealthy" : "healthy"),
        reason: health.get(name)?.reason ?? reason ?? null,
        checked_at: new Date().toISOString(),
        elapsed: 0.01,
      });
    }
    if (sub === "restart" && method === "POST") {
      if (refusedRestart.has(name)) return Response.json({ error: "upstream restart failed" }, { status: 502 });
      restarts.push(name);
      gateway502.delete(name);
      return Response.json({ sprite_name: name, machine_id: "m1", message: "queued" }, { status: 202 });
    }
    if (sub === "policy/network") {
      if (method === "GET") return Response.json({ rules: brokenReadback.has(name) ? [] : (policies.get(name) ?? []) });
      const parsed = JSON.parse(toBuf(init?.body).toString() || "{}") as { rules?: NetworkRule[] };
      policies.set(name, parsed.rules ?? []);
      return new Response(null, { status: 204 });
    }
    if (sub === "policy/resources") {
      if (method === "GET") {
        const r = resources.get(name);
        return Response.json({ memory: r ? { limit_mb: r.limitMB } : undefined });
      }
      if (method === "DELETE") {
        resources.delete(name);
        return new Response(null, { status: 204 });
      }
      const parsed = JSON.parse(toBuf(init?.body).toString() || "{}") as { memory?: { limit_mb?: number } };
      if (parsed.memory?.limit_mb !== undefined) resources.set(name, { limitMB: parsed.memory.limit_mb });
      return new Response(null, { status: 204 });
    }
    if (sub === "checkpoint" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { comment?: string };
      const id = `v${++checkpointSeq}`;
      const dir = join(root, ".checkpoints", name, id);
      cpSync(ensureDir(name), dir, { recursive: true });
      const list = checkpoints.get(name) ?? [];
      list.push({ id, createTime: new Date(Date.now() + list.length).toISOString(), dir });
      checkpoints.set(name, list);
      void body;
      return ndjson([
        { type: "info", data: `checkpoint ${id}` },
        { type: "complete", data: id },
      ]);
    }
    if (sub === "checkpoints" && method === "GET") {
      return Response.json([
        { id: "Current", create_time: new Date().toISOString() },
        ...(checkpoints.get(name) ?? []).map((c) => ({ id: c.id, create_time: c.createTime, comment: "qm turn end" })),
      ]);
    }
    const restore = /^checkpoints\/([^/]+)\/restore$/.exec(sub);
    if (restore && method === "POST") {
      const cp = (checkpoints.get(name) ?? []).find((c) => c.id === decodeURIComponent(restore[1]!));
      if (!cp) return notFound("checkpoint");
      const home = ensureDir(name);
      rmSync(home, { recursive: true, force: true });
      cpSync(cp.dir, home, { recursive: true });
      gateway502.delete(name);
      return ndjson([
        { type: "info", data: `restoring ${cp.id}` },
        { type: "complete", data: cp.id },
      ]);
    }
    if (sub === "fs/read" && method === "GET") {
      const target = hostPath(name, url.searchParams.get("path") ?? "");
      if (!existsSync(target)) return Response.json({ error: "no such file", path: target }, { status: 404 });
      return new Response(readFileSync(target), { status: 200 });
    }
    if (sub === "fs/write" && method === "PUT") {
      const path = url.searchParams.get("path") ?? "";
      const target = hostPath(name, path);
      const data = toBuf(init?.body);
      const mode = url.searchParams.get("mode");
      return fsResult(target, () => {
        if (url.searchParams.get("mkdirParents") === "true") mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, fakeSupervisorData(name, path, data));
        if (mode) chmodSync(target, Number.parseInt(mode, 8));
        return { path: target, size: data.length, mode: mode ?? "0644" };
      });
    }
    if (sub === "fs/rename" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { source?: string; dest?: string };
      return fsResult(body.source ?? "", () => {
        renameSync(hostPath(name, body.source ?? ""), hostPath(name, body.dest ?? ""));
        return { source: body.source, dest: body.dest };
      });
    }
    return notFound("route");
  };

  const exec = (url: URL): FakeExec | null => {
    const m = /^\/v1\/sprites\/([^/]+)\/exec$/.exec(url.pathname);
    if (!m) return null;
    const name = decodeURIComponent(m[1]!);
    const argv = url.searchParams.getAll("cmd");
    calls.push({ method: "WS", path: url.pathname });
    const call = calls[calls.length - 1]!;
    return {
      refused: !sprites.has(name) || gateway502.has(name),
      run: async (stdin) => {
        call.script = argv[argv.length - 1] === SCRIPT_RUNNER ? stdin.toString("utf8") : argv[argv.length - 1];
        const frames = await runExec(name, argv, stdin);
        const dropAfterRun = stallAfterRun.delete(name);
        return { frames, dropAfterRun };
      },
    };
  };

  engines.set(origin, { fetch: fetchImpl, exec });

  return {
    baseUrl: origin,
    calls,
    homeDir: (name) => ensureDir(name),
    names: () => [...sprites.keys()],
    policy: (name) => policies.get(name) ?? null,
    resources: (name) => resources.get(name) ?? null,
    checkpoints: (name) => (checkpoints.get(name) ?? []).map((c) => c.id),
    execScripts: () => [...execScripts],
    stallAfterRun: (name) => {
      stallAfterRun.add(name);
    },
    fail502: (name) => {
      gateway502.add(name);
    },
    failNext: (status, opts = {}) => {
      injected.push({ status, ...opts });
    },
    refuseRestart: (name) => {
      refusedRestart.add(name);
    },
    health: (name, status, reason) => {
      health.set(name, { status, reason });
    },
    unhealthy: (name, reason) => {
      unhealthy.set(name, reason);
    },
    refuseDelete: (status) => {
      refuseDeleteStatus = status;
    },
    rateLimitCreate: (retryAfterSeconds) => {
      rateLimitRetryAfter = retryAfterSeconds;
    },
    breakPolicyReadback: (name) => {
      brokenReadback.add(name);
    },
    setPressure: (name, p) => {
      const home = ensureDir(name);
      writeFileSync(
        join(home, ".proc-pressure-io"),
        `some avg10=${p.full10} avg60=${p.full60} avg300=0.00 total=0\nfull avg10=${p.full10} avg60=${p.full60} avg300=0.00 total=0\n`,
      );
      writeFileSync(join(home, ".proc-loadavg"), `${p.load1} 0.00 0.00 1/100 1\n`);
    },
    restarts: () => [...restarts],
    reset: () => {
      for (const name of Array.from(sprites.keys())) deleteSprite(name);
      execScripts.length = 0;
      calls.length = 0;
      stallAfterRun.clear();
      gateway502.clear();
      refusedRestart.clear();
      unhealthy.clear();
      health.clear();
      brokenReadback.clear();
      restarts.length = 0;
      injected.length = 0;
      refuseDeleteStatus = undefined;
      rateLimitRetryAfter = undefined;
    },
    cleanup: () => {
      engines.delete(origin);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let globalFake: FakeSprites | null = null;

export function installGlobalFakeSprites(): FakeSprites {
  if (globalFake) return globalFake;
  globalFake = installFakeSprites(API_ORIGIN);
  return globalFake;
}

export const FAKE_SPRITES_TOKEN = TOKEN;
