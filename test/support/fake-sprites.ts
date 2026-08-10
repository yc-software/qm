import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpritesClientLike } from "../../src/sandbox/sprites-sandbox.ts";

export interface NetworkRule {
  domain: string;
  action: string;
}

export interface SpritesCall {
  method: string;
  path: string;
  /** For exec calls: the script (last `cmd` argv element). */
  script?: string;
}

export interface FakeSprites {
  client: SpritesClientLike;
  fetchImpl: typeof fetch;
  calls: SpritesCall[];
  /** Host-side dir standing in for the sprite's disk — wipe it to simulate a replaced computer. */
  homeDir(name: string): string;
  names(): string[];
  policy(name: string): NetworkRule[] | null;
  execScripts(): string[];
  stallAfterRun(name: string): void;
  fail502(name: string): void;
  refuseRestart(name: string): void;
  restarts(): string[];
  reset(): void;
  cleanup(): void;
}

const TOKEN = "test-token";
const API_ORIGIN = "https://api.sprites.dev";

export function installFakeSprites(): FakeSprites {
  const root = mkdtempSync(join(tmpdir(), "fake-sprites-"));
  const sprites = new Map<string, { home: string }>();
  const policies = new Map<string, NetworkRule[]>();
  const execScripts: string[] = [];
  const calls: SpritesCall[] = [];
  const gateway502 = new Set<string>();
  const stallAfterRun = new Set<string>();
  const refusedRestart = new Set<string>();
  const restarts: string[] = [];

  const ensureDir = (name: string): string => {
    let s = sprites.get(name);
    if (!s) {
      s = { home: join(root, name) };
      mkdirSync(s.home, { recursive: true });
      sprites.set(name, s);
    }
    return s.home;
  };

  const remap = (name: string, script: string): string => {
    const home = ensureDir(name);
    const homeRe = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replace(/\/home\/sprite/g, home)
        .replace(remapPath, (m) => (m.startsWith(home) ? m : `${home}/tmp/`))
    );
  };

  const toBuf = (body: unknown): Buffer => {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    return Buffer.alloc(0);
  };

  const runExec = (name: string, script: string, stdin?: Buffer): Buffer => {
    execScripts.push(script);
    mkdirSync(join(ensureDir(name), "tmp"), { recursive: true });
    const r = spawnSync("sh", ["-c", remap(name, script)], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      ...(stdin ? { input: stdin } : {}),
    });
    const code = r.status ?? (r.signal ? 137 : -1);
    const frame = (id: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([id]), payload]);
    return Buffer.concat([
      frame(1, r.stdout ?? Buffer.alloc(0)),
      frame(2, r.stderr ?? Buffer.alloc(0)),
      Buffer.from([3, code & 0xff]),
    ]);
  };

  const deleteSprite = (name: string): void => {
    const s = sprites.get(name);
    if (s) rmSync(s.home, { recursive: true, force: true });
    sprites.delete(name);
    policies.delete(name);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const health = /^\/v1\/sprites\/([^/]+)\/check$/.exec(url.pathname);
    if (health) {
      const name = decodeURIComponent(health[1]!);
      if (!sprites.has(name)) return new Response("sprite not found", { status: 404 });
      return Response.json({ sprite_name: name, status: "healthy" });
    }
    const boot = /^\/v1\/sprites\/([^/]+)\/restart$/.exec(url.pathname);
    if (boot && method === "POST") {
      const name = decodeURIComponent(boot[1]!);
      if (!sprites.has(name)) return new Response("sprite not found", { status: 404 });
      if (refusedRestart.has(name)) return new Response('{"error":"upstream restart failed"}', { status: 502 });
      restarts.push(name);
      gateway502.delete(name);
      return Response.json({ sprite_name: name });
    }
    const sub = /\/v1\/sprites\/([^/]+)\/(exec|policy\/network)$/.exec(url.pathname);
    if (sub) {
      const name = decodeURIComponent(sub[1]!);
      if (sub[2] === "exec") {
        const argv = url.searchParams.getAll("cmd");
        const script = argv[argv.length - 1] ?? "";
        calls[calls.length - 1]!.script = script;
        const stdin = url.searchParams.get("stdin") === "true" ? toBuf(init?.body) : undefined;
        const stall = (): never => {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        };
        if (stallAfterRun.has(name)) {
          stallAfterRun.delete(name);
          runExec(name, script, stdin);
          stall();
        }
        if (gateway502.has(name)) {
          return new Response('{"error":"bad gateway"}', { status: 502 });
        }
        return new Response(runExec(name, script, stdin), { status: 200 });
      }
      if (method === "GET") return Response.json({ rules: policies.get(name) ?? [] });
      const parsed = JSON.parse(toBuf(init?.body).toString() || "{}") as { rules?: NetworkRule[] };
      policies.set(name, parsed.rules ?? []);
      return new Response(null, { status: 204 });
    }
    // The control plane the real SpritesClient dials: sprite CRUD.
    if (url.pathname === "/v1/sprites" && method === "POST") {
      const body = JSON.parse(toBuf(init?.body).toString() || "{}") as { name?: string };
      const name = body.name ?? "unnamed";
      ensureDir(name);
      return Response.json({ name });
    }
    const one = /^\/v1\/sprites\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const name = decodeURIComponent(one[1]!);
      if (method === "GET") {
        return sprites.has(name) ? Response.json({ name }) : new Response("sprite not found", { status: 404 });
      }
      if (method === "DELETE") {
        deleteSprite(name);
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  const client: SpritesClientLike = {
    async getSprite(name: string) {
      if (!sprites.has(name)) throw new Error(`sprite ${name} not found (404)`);
      return { name };
    },
    async createSprite(name: string) {
      ensureDir(name);
      return { name };
    },
    async deleteSprite(name: string) {
      deleteSprite(name);
    },
  };

  return {
    client,
    fetchImpl,
    calls,
    homeDir: (name) => ensureDir(name),
    names: () => [...sprites.keys()],
    policy: (name) => policies.get(name) ?? null,
    execScripts: () => [...execScripts],
    stallAfterRun: (name) => {
      stallAfterRun.add(name);
    },
    fail502: (name) => {
      gateway502.add(name);
    },
    refuseRestart: (name) => {
      refusedRestart.add(name);
    },
    restarts: () => [...restarts],
    reset: () => {
      for (const name of Array.from(sprites.keys())) deleteSprite(name);
      execScripts.length = 0;
      calls.length = 0;
      stallAfterRun.clear();
      gateway502.clear();
      refusedRestart.clear();
      restarts.length = 0;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let globalFake: FakeSprites | null = null;

/** Patch globalThis.fetch so the REAL SpritesClient (and the backend's default fetch) lands on an
 *  in-memory fake instead of api.sprites.dev — the app-level test substrate (see test-config.ts). */
export function installGlobalFakeSprites(): FakeSprites {
  if (globalFake) return globalFake;
  const fake = installFakeSprites();
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = async (input, init) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    if (url.startsWith(`${API_ORIGIN}/`)) return fake.fetchImpl(input, init);
    return realFetch(input, init);
  };
  globalFake = fake;
  return fake;
}

export const FAKE_SPRITES_TOKEN = TOKEN;
