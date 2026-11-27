import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface FakeBox {
  name: string;
  status: string;
  image: string;
  memory: number;
  root: string;
  volume: string | undefined;
}

export interface FakeBaseten {
  fetchImpl: typeof fetch;
  names(): string[];
  box(name: string): { status: string; image: string; memory: number } | null;
  volume(name: string): { attachedTo: string | undefined } | null;
  setStatus(name: string, status: string): void;
  expire(name: string): void;
  slowDeletes(): void;
  cutOffNextExec(): void;
  returnNextExecRunning(): void;
  dropNextExecConnection(): void;
  refuseNextExec(): void;
  dropNextExitCode(): void;
  cleanup(): void;
}

export const FAKE_BASETEN_API = "https://api.baseten.test";
const DATA_HOST = /^sbx-(.+)\.baseten\.test$/;

export function installFakeBaseten(): FakeBaseten {
  const root = mkdtempSync(join(tmpdir(), "fake-baseten-"));
  const boxes = new Map<string, FakeBox>();
  const processes = new Map<string, Record<string, unknown>>();
  const volumes = new Map<string, string>();
  const gone = new Set(["TERMINATED", "FAILED", "DELETING"]);
  let generation = 0;
  let minted = 0;
  const validTokens = new Set<string>();
  let slowDelete = false;
  let cutOff = false;
  let returnRunning = false;
  let dropConnection = false;
  let refuse = false;
  let dropExitCode = false;

  const view = (b: FakeBox) => ({
    name: b.name,
    url: `https://sbx-${b.name}.baseten.test`,
    status: b.status,
    image: b.image,
    memory: b.memory,
    created_at: "2026-11-09T00:00:00Z",
    expires_in: 7 * 24 * 3600,
  });
  const error = (status: number, code: string, message: string) => Response.json({ code, message }, { status });
  const attachedTo = (volume: string) =>
    [...boxes.values()].find((b) => b.volume === volume && !gone.has(b.status))?.name;
  const volumeView = (name: string, status = "DEPLOYED") => ({
    name,
    size: "10Gi",
    region: "us-test-1",
    status,
    attached_to: attachedTo(name),
  });

  const runCommand = (b: FakeBox, command: string) => {
    const script = command
      .replace(/\btimeout -k \d+ \d+ /g, "")
      .replace(/\/root(?![A-Za-z0-9._-])/g, `${b.root}/root`)
      .replace(/\/tmp\//g, `${b.root}/tmp/`);
    mkdirSync(join(b.root, "tmp"), { recursive: true });
    const r = spawnSync("sh", ["-c", script], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return {
      exitCode: r.status ?? (r.signal ? 137 : -1),
      stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  };

  const create = (body: {
    name: string;
    image: string;
    memory: number;
    create_if_not_exists?: boolean;
    volumes?: { name: string; mount_path: string }[];
  }) => {
    const existing = boxes.get(body.name);
    if (existing && !gone.has(existing.status)) {
      if (!body.create_if_not_exists) return error(409, "ALREADY_EXISTS", "A sandbox with this name already exists.");
      return Response.json(view(existing), { status: 201 });
    }
    const box: FakeBox = {
      name: body.name,
      status: "DEPLOYING",
      image: body.image,
      memory: body.memory,
      root: join(root, `${body.name}-${++generation}`),
      volume: body.volumes?.find((v) => v.mount_path === "/root")?.name,
    };
    mkdirSync(box.root, { recursive: true });
    if (box.volume) symlinkSync(volumes.get(box.volume)!, join(box.root, "root"));
    else mkdirSync(join(box.root, "root"));
    boxes.set(box.name, box);
    return Response.json(view(box), { status: 201 });
  };

  const management = async (url: URL, method: string, init: RequestInit | undefined): Promise<Response> => {
    if (url.pathname === "/v1/sandboxes/instances" && method === "POST")
      return create(JSON.parse(String(init?.body)) as Parameters<typeof create>[0]);
    if (url.pathname === "/v1/sandboxes/volumes" && method === "POST") {
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      volumes.set(name, mkdtempSync(join(root, "volume-")));
      return Response.json(volumeView(name), { status: 201 });
    }
    if (url.pathname.startsWith("/v1/sandboxes/volumes/")) {
      const name = decodeURIComponent(url.pathname.slice("/v1/sandboxes/volumes/".length));
      if (!volumes.has(name)) return error(404, "NOT_FOUND", "The requested resource was not found.");
      if (method === "GET") return Response.json(volumeView(name));
      if (attachedTo(name)) return error(409, "RESOURCE_IN_USE", "Volume is attached");
      volumes.delete(name);
      return Response.json(volumeView(name, "DELETING"), { status: 202 });
    }
    const named = /^\/v1\/sandboxes\/instances\/([^/]+)$/.exec(url.pathname);
    if (!named) return error(404, "NOT_FOUND", `no route ${method} ${url.pathname}`);
    const box = boxes.get(decodeURIComponent(named[1]!));
    if (!box || box.status === "TERMINATED") return error(404, "NOT_FOUND", "The requested resource was not found.");
    if (method === "GET") {
      if (box.status === "DEPLOYING") box.status = "DEPLOYED";
      return Response.json(view(box));
    }
    if (method === "DELETE") {
      box.status = slowDelete ? "DELETING" : "TERMINATED";
      return Response.json(view(box), { status: 202 });
    }
    return error(405, "METHOD_NOT_ALLOWED", method);
  };

  const runtime = async (box: FakeBox, url: URL, method: string, init: RequestInit | undefined) => {
    if (url.pathname === "/process" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { command: string; name: string; waitForCompletion?: boolean };
      if (refuse) {
        refuse = false;
        return new Response("waking up", { status: 503 });
      }
      const { exitCode, ...output } = runCommand(box, body.command);
      const finished = { name: body.name, ...output, exitCode, status: exitCode === 0 ? "completed" : "failed" };
      const done = dropExitCode ? { name: body.name, ...output, status: "killed" } : finished;
      dropExitCode = false;
      processes.set(`${box.name}/${body.name}`, { ...done, startedAt: "2026-11-09T00:00:00Z" });
      if (cutOff) {
        cutOff = false;
        return new Response("gateway timeout", { status: 504 });
      }
      if (dropConnection) {
        dropConnection = false;
        throw new TypeError("fetch failed");
      }
      if (returnRunning || !body.waitForCompletion) {
        returnRunning = false;
        return Response.json({ name: body.name, status: "running", startedAt: "2026-11-09T00:00:00Z" });
      }
      return Response.json(processes.get(`${box.name}/${body.name}`));
    }
    const proc = /^\/process\/([^/]+)$/.exec(url.pathname);
    if (proc && method === "GET") {
      const found = processes.get(`${box.name}/${decodeURIComponent(proc[1]!)}`);
      return found ? Response.json(found) : Response.json({ error: "process not found" }, { status: 404 });
    }
    if (url.pathname.startsWith("/filesystem/")) {
      const abs = decodeURIComponent(url.pathname.slice("/filesystem/".length)).replace(/^\/*/, "/");
      const target = join(box.root, abs);
      if (method === "PUT") {
        const file = (init!.body as FormData).get("file") as Blob;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(await file.arrayBuffer()));
        return Response.json({ path: abs, message: "ok" });
      }
      if (method === "GET") {
        try {
          if (statSync(target).isDirectory()) return Response.json({ path: abs, files: [] });
          return new Response(readFileSync(target), { headers: { "content-type": "application/octet-stream" } });
        } catch {
          return Response.json({ error: `stat ${abs}: no such file or directory` }, { status: 404 });
        }
      }
    }
    return Response.json({ error: `no route ${method} ${url.pathname}` }, { status: 404 });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (url.host === new URL(FAKE_BASETEN_API).host && url.pathname === "/v1/token" && method === "POST") {
      const token = `sbx-token-${++minted}`;
      validTokens.add(token);
      return Response.json({ token, expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() });
    }
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!validTokens.has(bearer))
      return error(401, "UNAUTHENTICATED", "Provide a valid authentication token in the Authorization header.");
    const dataHost = DATA_HOST.exec(url.host);
    if (!dataHost) return management(url, method, init);
    const box = boxes.get(dataHost[1]!);
    if (!box || gone.has(box.status)) return new Response("sandbox not found", { status: 502 });
    return runtime(box, url, method, init);
  };

  return {
    fetchImpl,
    names: () => [...boxes.values()].filter((b) => b.status !== "TERMINATED").map((b) => b.name),
    box: (name) => {
      const b = boxes.get(name);
      return b ? { status: b.status, image: b.image, memory: b.memory } : null;
    },
    volume: (name) => (volumes.has(name) ? { attachedTo: attachedTo(name) } : null),
    setStatus: (name, status) => {
      const b = boxes.get(name);
      if (b) b.status = status;
    },
    expire: (name) => {
      boxes.delete(name);
    },
    slowDeletes: () => {
      slowDelete = true;
    },
    cutOffNextExec: () => {
      cutOff = true;
    },
    returnNextExecRunning: () => {
      returnRunning = true;
    },
    dropNextExecConnection: () => {
      dropConnection = true;
    },
    refuseNextExec: () => {
      refuse = true;
    },
    dropNextExitCode: () => {
      dropExitCode = true;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
