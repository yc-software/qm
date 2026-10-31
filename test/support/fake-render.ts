import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import {
  RENDER_SCRIPT_DIR,
  type RenderClient,
  type RenderImage,
  type RenderSandboxInfo,
  type RenderSnapshot,
} from "../../src/sandbox/render-client.ts";
import type { RenderApi } from "../../src/deploy/render-api.ts";
import type { Deployment } from "../../src/deploy/deploy-store.ts";
import { scopeId } from "../../src/types.ts";

export function fakeDeployment(versions: Deployment["versions"] = []): Deployment {
  return {
    id: randomUUID(),
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions,
  };
}

export interface FakeRenderApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

export function createFakeRenderApi(
  handle: (call: FakeRenderApiCall) => unknown,
): RenderApi & { calls: FakeRenderApiCall[] } {
  const calls: FakeRenderApiCall[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
      const url = new URL(path, "https://render.test");
      const call = { method, path: url.pathname, query: url.searchParams, body };
      calls.push(call);
      return (await handle(call)) as T | null;
    },
  };
}

export function createFakeRender() {
  const execFileAsync = promisify(execFile);
  const root = mkdtempSync(join(tmpdir(), "fake-render-"));
  const sandboxes = new Map<string, RenderSandboxInfo>();
  const snapshots = new Map<string, RenderSnapshot>();
  const snapshotSources = new Map<string, { sandboxId: string; name: string; requestedAtMs: number }>();
  const images = new Map<string, RenderImage & { name: string; source: string }>();
  const goldens = new Map<string, RenderSnapshot>();
  const registry = new Map<string, string>();
  const imports: Array<{ source: string; name: string }> = [];
  let importFailure: string | undefined;
  let slowImports = false;
  const createdFrom: Array<string | undefined> = [];
  const commands: string[] = [];
  const deleted: string[] = [];
  const terminated: string[] = [];
  let checkpointError: Error | undefined;
  let loseCheckpointReply: RenderSnapshot["status"] | undefined;
  let terminateError: Error | undefined;
  const terminateErrors = new Map<string, Error>();
  const home = (id: string): string => join(root, id);
  const requireRunning = (id: string): RenderSandboxInfo => {
    const info = sandboxes.get(id);
    if (info?.status !== "running") throw new Error(`Render sandbox ${id} is no longer running`);
    return info;
  };
  const mapped = (id: string, path: string): string => {
    if (path.startsWith(`${root}/`)) return path;
    if (path.startsWith(`${RENDER_SCRIPT_DIR}/`)) return `${home(id)}${path}`;
    return path.replace(/^\/tmp\//, `${home(id)}/tmp/`).replace(/^\/root(?![A-Za-z0-9_-])/, home(id));
  };
  const execute = async (id: string, script: string) => {
    mkdirSync(join(home(id), "tmp"), { recursive: true });
    const file = join(root, `run-${randomUUID()}.sh`);
    writeFileSync(
      file,
      script
        .replace(/\/tmp\//g, `${home(id)}/tmp/`)
        .replace(/\/root(?![A-Za-z0-9_-])/g, home(id))
        .replace(/tar --no-recursion --null -T ('[^']+') -cf ('[^']+')/g, "xargs -0 tar --no-recursion -cf $2 -- < $1")
        .replaceAll(RENDER_SCRIPT_DIR, `${home(id)}${RENDER_SCRIPT_DIR}`),
    );
    try {
      const result = await execFileAsync("/bin/sh", [file], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home(id), COPYFILE_DISABLE: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (typeof result.code !== "number") throw new Error(result.message, { cause: error });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code };
    } finally {
      rmSync(file, { force: true });
    }
  };
  const runProxyCommand = async (id: string, command: string) => {
    requireRunning(id);
    const spooled = /^timeout \d+ sh '([^']+)'$/.exec(command);
    if (!spooled) return execute(id, command);
    const script = mapped(id, spooled[1]!);
    if (!existsSync(script)) return { stdout: "", stderr: `sh: cannot open ${spooled[1]}`, exitCode: 2 };
    return execute(id, readFileSync(script, "utf8"));
  };
  const startImport = (source: string, name: string) => {
    imports.push({ source, name });
    const digest = registry.get(source);
    if (!digest) throw new Error(`no image published at ${source}`);
    const existing = [...images.values()].find(
      (image) => image.name === name && image.sourceDigest === digest && image.status !== "failed",
    );
    if (existing) return existing;
    const id = `sbb-${String(images.size + 1).padStart(20, "0")}`;
    const ready: RenderImage["status"] = slowImports ? "running" : "succeeded";
    const image: RenderImage & { name: string; source: string } = {
      id,
      status: importFailure ? "failed" : ready,
      sourceDigest: digest,
      name,
      source,
    };
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, ".base-image"), `${source}@${digest}\n`);
    images.set(id, image);
    return image;
  };
  const client: RenderClient = {
    async create({ snapshotId, image, lifetimeSec, onCreated }) {
      const id = `sbx-${sandboxes.size + 1}`;
      const info: RenderSandboxInfo = { id, status: "running", expiresAtMs: Date.now() + lifetimeSec * 1000 };
      if (snapshotId) {
        if ((snapshots.get(snapshotId) ?? goldens.get(snapshotId))?.status !== "available")
          throw new Error("checkpoint unavailable");
        cpSync(join(root, snapshotId), home(id), { recursive: true });
      } else if (image) {
        if (images.get(image)?.status !== "succeeded") throw new Error(`image ${image} is not ready`);
        cpSync(join(root, image), home(id), { recursive: true });
      } else {
        mkdirSync(home(id), { recursive: true });
      }
      sandboxes.set(id, info);
      createdFrom.push(snapshotId ?? image);
      try {
        await onCreated?.(id);
      } catch (error) {
        info.status = "terminated";
        terminated.push(id);
        throw error;
      }
      return { ...info };
    },
    async importImage(source, name) {
      const image = startImport(source, name);
      return {
        id: image.id,
        status: image.status,
        sourceDigest: image.sourceDigest,
        ...(image.status === "failed" ? { failureReason: importFailure } : {}),
      };
    },
    async get(id) {
      return sandboxes.get(id) ?? null;
    },
    async terminate(id) {
      if (terminateError ?? terminateErrors.get(id)) throw terminateError ?? terminateErrors.get(id);
      terminated.push(id);
      const info = sandboxes.get(id);
      if (info) info.status = "terminated";
      rmSync(home(id), { recursive: true, force: true });
    },
    async runScript(id, script) {
      requireRunning(id);
      commands.push(script);
      return execute(id, script);
    },
    async readFileBytes(id, path) {
      requireRunning(id);
      return existsSync(mapped(id, path)) ? readFileSync(mapped(id, path)) : null;
    },
    async writeFileBytes(id, path, data) {
      requireRunning(id);
      const dest = mapped(id, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    },
    async createSnapshot(id, name) {
      requireRunning(id);
      if (checkpointError) throw checkpointError;
      const snapshotId = `snp-${snapshots.size + deleted.length + 1}`;
      const snapshot: RenderSnapshot = {
        id: snapshotId,
        sandboxGroupId: "sbg-test",
        status: "available",
        expiresAtMs: Date.now() + 86400_000,
        capturedAtMs: Date.now(),
      };
      cpSync(home(id), join(root, snapshotId), { recursive: true });
      snapshots.set(snapshotId, snapshot);
      snapshotSources.set(snapshotId, { sandboxId: id, name, requestedAtMs: snapshot.capturedAtMs! });
      if (loseCheckpointReply) {
        snapshot.status = loseCheckpointReply;
        loseCheckpointReply = undefined;
        throw new Error("connection reset");
      }
      return { ...snapshot };
    },
    async getSnapshot(snapshot) {
      const value = snapshots.get(snapshot.id);
      if (!value)
        throw new SandboxSnapshotNotFoundError(`Render checkpoint ${snapshot.id} is no longer available`, 404);
      return { ...value };
    },
    async waitSnapshot(snapshot) {
      const value = await client.getSnapshot(snapshot);
      if (value.status === "failed")
        throw new Error(`Render checkpoint ${value.id} failed: ${value.error || "no provider reason"}`);
      if (value.status === "creating") throw new Error(`Render checkpoint ${value.id} did not finish`);
      return value;
    },
    async deleteSnapshot(snapshot) {
      if (snapshots.get(snapshot.id)?.status === "creating") throw new Error("snapshot_creating");
      deleted.push(snapshot.id);
      snapshots.delete(snapshot.id);
      rmSync(join(root, snapshot.id), { recursive: true, force: true });
    },
  };
  return {
    client,
    sandboxes,
    snapshots,
    createdFrom,
    images,
    imports,
    startImport,
    commands,
    deleted,
    terminated,
    home,
    runProxyCommand,
    seedGolden(ref: string) {
      const id = `snp-golden-${goldens.size + 1}`;
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, ".base-image"), `${ref}\n`);
      goldens.set(id, { id, sandboxGroupId: "sbg-test", status: "available", expiresAtMs: Date.now() + 86400_000 });
      return id;
    },
    publishImage(source: string, digest: string) {
      registry.set(source, digest);
    },
    failImport(reason?: string) {
      importFailure = reason;
    },
    slowImports(on = true) {
      slowImports = on;
      if (!on) for (const image of images.values()) if (image.status === "running") image.status = "succeeded";
    },
    failCheckpoint(error?: Error) {
      checkpointError = error;
    },
    loseCheckpointReply(status: RenderSnapshot["status"] = "available") {
      loseCheckpointReply = status;
    },
    snapshotSource(snapshotId: string) {
      return snapshotSources.get(snapshotId);
    },
    failTerminate(error?: Error, sandboxId?: string) {
      if (sandboxId) {
        if (error) terminateErrors.set(sandboxId, error);
        else terminateErrors.delete(sandboxId);
      } else terminateError = error;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface FakeRenderTokenRequest {
  sandboxId: string;
  operation: string;
  body: string;
}

export function serveFakeRenderApi(
  t: TestContext,
  fake: ReturnType<typeof createFakeRender>,
  intercept?: (request: Request) => Response | undefined,
) {
  const tokenRequests: FakeRenderTokenRequest[] = [];
  const proxyCommands: string[] = [];
  const uploads: Array<{ sandboxId: string; path: string; data: Buffer }> = [];
  const lifetimes = new Map<string, { timeoutSeconds: number; createdAt: string }>();
  const sandboxJson = (id: string) => ({
    id,
    status: fake.sandboxes.get(id)!.status,
    plan: "starter",
    region: "oregon",
    networkPolicy: { type: "allow-all" },
    timeoutSeconds: 86400,
    createdAt: new Date().toISOString(),
    ...lifetimes.get(id),
  });
  const snapshotJson = (snapshot: RenderSnapshot) => ({
    id: snapshot.id,
    name: fake.snapshotSource(snapshot.id)?.name ?? null,
    sandboxGroupId: snapshot.sandboxGroupId,
    sourceSandboxId: fake.snapshotSource(snapshot.id)?.sandboxId ?? "sbx-source",
    kind: "filesystem",
    status: snapshot.status,
    plan: "starter",
    requestedAt: new Date().toISOString(),
    ...(snapshot.capturedAtMs ? { capturedAt: new Date(snapshot.capturedAtMs).toISOString() } : {}),
    expiresAt: new Date(snapshot.expiresAtMs).toISOString(),
  });
  const imageJson = (id: string) => {
    const stored = fake.images.get(id)!;
    const colon = stored.source.lastIndexOf(":");
    const [repository, reference] = [stored.source.slice(0, colon), stored.source.slice(colon + 1)];
    return {
      id,
      sandboxGroupId: "sbg-test",
      name: stored.name,
      source: { repository, image: repository.split("/").pop(), reference },
      sourceDigest: stored.sourceDigest,
      status: stored.status,
      ...(stored.status === "failed" ? { failureReason: "import failed" } : {}),
      createdAt: new Date().toISOString(),
    };
  };
  const missing = () => Response.json({ message: "not found" }, { status: 404 });
  const api = async (request: Request, path: string, query: URLSearchParams): Promise<Response> => {
    let match: RegExpExecArray | null;
    if (request.method === "POST" && path === "/sandboxes") {
      const body = (await request.json()) as { snapshotId?: string; buildId?: string; timeoutSeconds?: number };
      const { id } = await fake.client.create({
        ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}),
        ...(body.buildId ? { image: body.buildId } : {}),
        lifetimeSec: body.timeoutSeconds ?? 86400,
      });
      lifetimes.set(id, { timeoutSeconds: body.timeoutSeconds ?? 86400, createdAt: new Date().toISOString() });
      return Response.json(sandboxJson(id), { status: 201 });
    }
    if ((match = /^\/sandboxes\/([^/]+)$/.exec(path)))
      return fake.sandboxes.has(match[1]!) ? Response.json(sandboxJson(match[1]!)) : missing();
    if ((match = /^\/sandboxes\/([^/]+)\/terminate$/.exec(path)) && request.method === "POST") {
      if (!fake.sandboxes.has(match[1]!)) return missing();
      await fake.client.terminate(match[1]!);
      return new Response(null, { status: 204 });
    }
    if ((match = /^\/sandboxes\/([^/]+)\/(runs|files)\/([a-z]+)\/token$/.exec(path))) {
      const [, sandboxId, kind, operation] = match as unknown as [string, string, string, string];
      tokenRequests.push({ sandboxId, operation, body: await request.text() });
      if (kind === "runs")
        return Response.json({
          uri: `https://${sandboxId}.sandbox.test/runs/${operation}`,
          method: "POST",
          token: "run-token",
          executionId: `exe-${tokenRequests.length}`,
        });
      const target = new URL(`https://${sandboxId}.sandbox.test/files`);
      target.searchParams.set("path", query.get("path")!);
      return Response.json({
        uri: target.toString(),
        method: operation === "upload" ? "PUT" : "GET",
        token: "file-token",
      });
    }
    if ((match = /^\/sandboxes\/([^/]+)\/snapshots$/.exec(path)) && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      return Response.json(snapshotJson(await fake.client.createSnapshot(match[1]!, body.name)), { status: 201 });
    }
    if (path === "/sandbox-groups" && request.method === "GET")
      return Response.json([
        {
          sandboxGroup: {
            id: "sbg-test",
            ownerId: "tea-test",
            name: "Default",
            region: "oregon",
            isDefault: true,
            concurrencyLimit: 20,
          },
          cursor: "sbg-test",
        },
      ]);
    if (path === "/sandbox-groups/sbg-test/builds" && request.method === "POST") {
      const body = (await request.json()) as { name: string; sourceImage: string };
      return Response.json(imageJson(fake.startImport(body.sourceImage, body.name).id), { status: 201 });
    }
    if ((match = /^\/sandbox-groups\/sbg-test\/builds\/([^/]+)$/.exec(path))) {
      return fake.images.has(match[1]!) ? Response.json(imageJson(match[1]!)) : missing();
    }
    if (path === "/sandbox-groups/sbg-test/snapshots" && request.method === "GET")
      return Response.json(
        [...fake.snapshots.values()]
          .sort(
            (a, b) => (fake.snapshotSource(b.id)?.requestedAtMs ?? 0) - (fake.snapshotSource(a.id)?.requestedAtMs ?? 0),
          )
          .map((snapshot) => ({ snapshot: snapshotJson(snapshot), cursor: snapshot.id })),
      );
    if ((match = /^\/sandbox-groups\/([^/]+)\/snapshots\/([^/]+)$/.exec(path))) {
      const ref: RenderSnapshot = { id: match[2]!, sandboxGroupId: match[1]!, status: "available", expiresAtMs: 0 };
      if (request.method === "DELETE") {
        await fake.client.deleteSnapshot(ref);
        return new Response(null, { status: 204 });
      }
      if (!fake.snapshots.has(ref.id)) return missing();
      return Response.json(snapshotJson(await fake.client.getSnapshot(ref)));
    }
    throw new Error(`Unexpected Render API request ${request.method} ${path}`);
  };
  const sandboxProxy = async (request: Request, sandboxId: string, url: URL): Promise<Response> => {
    if (url.pathname.startsWith("/runs/")) {
      const { command } = (await request.json()) as { command: string };
      proxyCommands.push(command);
      const result = await fake.runProxyCommand(sandboxId, command);
      const output = (stream: string, data: string) =>
        data ? [`event: output\ndata: ${JSON.stringify({ stream, data })}\n\n`] : [];
      return new Response(
        [
          ...output("stdout", result.stdout),
          ...output("stderr", result.stderr),
          `event: exit\ndata: ${JSON.stringify({ exit_code: result.exitCode })}\n\n`,
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const path = url.searchParams.get("path")!;
    if (request.method === "PUT") {
      const data = Buffer.from(await request.arrayBuffer());
      uploads.push({ sandboxId, path, data });
      await fake.client.writeFileBytes(sandboxId, path, data);
      return new Response(null, { status: 204 });
    }
    const data = await fake.client.readFileBytes(sandboxId, path);
    return data ? new Response(data) : missing();
  };
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const intercepted = intercept?.(request);
    if (intercepted) return intercepted;
    if (url.hostname === "api.render.com") return api(request, url.pathname.replace(/^\/v1/, ""), url.searchParams);
    const proxy = /^(.+)\.sandbox\.test$/.exec(url.hostname);
    if (proxy) return sandboxProxy(request, proxy[1]!, url);
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  });
  return { tokenRequests, proxyCommands, uploads };
}
