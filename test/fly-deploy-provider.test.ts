import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createFlyDeployProvider,
  type FlyDeployProviderOptions,
  type FlyMachine,
  type FlyMachineConfig,
} from "../src/deploy/fly-deploy-provider.ts";
import { parseTar } from "../src/sandbox/tar.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const TOKEN = "FlyV1-test-token";
const PREFIX = "qm-d";
const IMAGE =
  "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const ORG = "acme";
const ID = "550e8400-e29b-41d4-a716-446655440000";
const APP = `${PREFIX}-550e8400-e29`;

interface FlyCall {
  method: string;
  path: string;
  query: string;
  auth: string | null;
  body: Record<string, unknown> | undefined;
}

interface FakeFlyOptions {
  createAppStatus?: number;
  createAppBody?: string;
  deleteAppStatus?: number;
  existingMachines?: string[];
  states?: string[];
  events?: FlyMachine["events"];
}

function fakeFly(opts: FakeFlyOptions = {}) {
  const calls: FlyCall[] = [];
  const machines = new Map<string, string>();
  for (const id of opts.existingMachines ?? []) machines.set(id, "started");
  const states = [...(opts.states ?? ["started"])];
  const nextState = (): string => (states.length > 1 ? states.shift()! : (states[0] ?? "started"));
  let created = 0;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean);
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      auth: new Headers(init.headers).get("authorization"),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && segments.length === 2)
      return new Response(opts.createAppBody ?? "{}", { status: opts.createAppStatus ?? 201 });
    if (method === "DELETE" && segments.length === 3)
      return new Response("{}", { status: opts.deleteAppStatus ?? 202 });
    if (method === "GET" && segments.length === 4)
      return json(
        200,
        [...machines.keys()].map((id) => ({ id, state: machines.get(id) })),
      );
    if (method === "POST" && segments.length === 4) {
      const id = `machine-${++created}`;
      machines.set(id, "created");
      return json(200, { id, state: "created" });
    }
    const machineId = segments[4] ?? "";
    if (method === "GET" && segments.length === 5) {
      if (!machines.has(machineId)) return json(404, { error: "not found" });
      const state = nextState();
      machines.set(machineId, state);
      return json(200, { id: machineId, state, ...(opts.events ? { events: opts.events } : {}) });
    }
    if (method === "DELETE" && segments.length === 5) {
      machines.delete(machineId);
      return json(200, {});
    }
    return json(500, { error: `unexpected ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, machines };
}

function provider(fetchImpl: typeof fetch, extra: Partial<FlyDeployProviderOptions> = {}) {
  return createFlyDeployProvider({
    token: TOKEN,
    appPrefix: PREFIX,
    baseImage: IMAGE,
    org: ORG,
    fetchImpl,
    dialPort: async () => true,
    pollIntervalMs: 1,
    machineStartTimeoutMs: 200,
    appReadyTimeoutMs: 200,
    ...extra,
  });
}

function deployment(id: string): Deployment {
  return {
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
  };
}

function snapshot(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "fly-deploy-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

function version(snapshotDir: string, over: Partial<DeploymentVersion> = {}): DeploymentVersion {
  return { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir, env: { API_KEY: "secret" }, ...over };
}

const machineCreate = (calls: FlyCall[]): { region: string; config: FlyMachineConfig } =>
  calls.find((c) => c.method === "POST" && c.path.endsWith("/machines"))!.body as unknown as {
    region: string;
    config: FlyMachineConfig;
  };

test("apply: creates the Fly app, injects the snapshot as a machine file, and returns a private 6PN endpoint", async () => {
  const { fetchImpl, calls } = fakeFly();
  const endpoint = await provider(fetchImpl).apply(
    deployment(ID),
    version(snapshot({ "index.html": "<h1>hi</h1>", "lib/util.js": "export const x = 1;" })),
  );

  assert.deepEqual(endpoint, { host: `${APP}.internal`, port: 8080 });
  assert.equal(endpoint.tls, undefined, "6PN dialing is plaintext — the proxy must not attempt TLS");
  assert.equal(endpoint.httpVersion, undefined, "the core proxy defaults to HTTP/1.1");

  const createApp = calls.find((c) => c.method === "POST" && c.path === "/v1/apps")!;
  assert.deepEqual(createApp.body, { app_name: APP, org_slug: ORG });
  assert.equal(createApp.auth, `Bearer ${TOKEN}`);

  const { region, config } = machineCreate(calls);
  assert.equal(region, "lhr");
  assert.equal(config.image, IMAGE);
  assert.deepEqual(config.env, { API_KEY: "secret", PORT: "8080" });
  assert.deepEqual(config.guest, { cpu_kind: "shared", cpus: 1, memory_mb: 512 });
  assert.deepEqual(config.services, [], "no Fly proxy services — published apps stay reachable only over 6PN");
  assert.equal(config.files[0]!.guest_path, "/app.tar.gz");
  assert.deepEqual(config.init.exec.slice(0, 2), ["/bin/sh", "-lc"]);
  assert.match(config.init.exec[2]!, /tar -xzf \/app\.tar\.gz -C \/app/);
  assert.match(config.init.exec[2]!, /exec sh -lc 'node server\.js'/);

  const unpacked = await parseTar(gunzipSync(Buffer.from(config.files[0]!.raw_value, "base64")));
  assert.deepEqual(
    unpacked.map((f) => f.path).sort(),
    ["index.html", "lib/util.js"],
    "the whole snapshot tree rides in the machine file",
  );
  assert.equal(unpacked.find((f) => f.path === "index.html")!.data.toString("utf8"), "<h1>hi</h1>");
});

test("apply: never allocates a public IP", async () => {
  const { fetchImpl, calls } = fakeFly();
  await provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));
  assert.ok(
    !calls.some((c) => c.path.includes("ips") || c.path.includes("allocate")),
    "a published app must not become publicly routable",
  );
});

test("apply: an app that already exists is not an error", async () => {
  for (const over of [
    { createAppStatus: 409 },
    { createAppStatus: 422, createAppBody: '{"error":"Name has already been taken"}' },
  ]) {
    const { fetchImpl } = fakeFly(over);
    const endpoint = await provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));
    assert.deepEqual(endpoint, { host: `${APP}.internal`, port: 8080 });
  }
});

test("apply: a rejected app creation still surfaces", async () => {
  const { fetchImpl } = fakeFly({ createAppStatus: 401, createAppBody: '{"error":"unauthorized"}' });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /create app .*http 401.*unauthorized/,
  );
});

test("apply: the previous version's machines are destroyed before the new one is created", async () => {
  const { fetchImpl, calls, machines } = fakeFly({ existingMachines: ["machine-old"] });
  await provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));

  const destroyIndex = calls.findIndex((c) => c.method === "DELETE" && c.path.endsWith("/machines/machine-old"));
  const createIndex = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/machines"));
  assert.ok(destroyIndex >= 0, "the stale machine is destroyed");
  assert.ok(destroyIndex < createIndex, "the stale machine goes before the replacement arrives");
  assert.equal(calls[destroyIndex]!.query, "?force=true");
  assert.deepEqual([...machines.keys()], ["machine-1"]);
});

test("apply: an app bundle over the machine-file cap is refused with its actual and maximum size", async () => {
  const { fetchImpl, calls } = fakeFly();
  const big = snapshot({ "blob.bin": randomBytes(1_800_000) });
  await assert.rejects(provider(fetchImpl).apply(deployment(ID), version(big)), (e: Error) => {
    assert.match(e.message, /app bundle is too large for the Fly deploy provider/);
    assert.match(e.message, /maximum 2000000 bytes/);
    assert.match(e.message, /^the app bundle is too large for the Fly deploy provider: \d{7,} bytes/);
    return true;
  });
  assert.deepEqual(calls, [], "nothing is created on Fly for a bundle that could never be injected");
});

test("apply: a machine that never starts reports its last state", async () => {
  const { fetchImpl } = fakeFly({ states: ["created"] });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /never reached state "started" within 0s \(last state: created\)/,
  );
});

test("apply: an entrypoint that exits without binding the port reports why, with the machine's exit event", async () => {
  const { fetchImpl } = fakeFly({
    states: ["started", "stopped"],
    events: [{ request: { exit_event: { exit_code: 127, oom_killed: false } } }],
  });
  await assert.rejects(
    provider(fetchImpl, { dialPort: async () => false }).apply(
      deployment(ID),
      version(snapshot({ "index.html": "hi" })),
    ),
    /entrypoint exited without binding port 8080 \(fly machine machine-1 is stopped\).*exit code 127/s,
  );
});

test("apply: an app that stays up but never listens reports the readiness window", async () => {
  const { fetchImpl } = fakeFly();
  await assert.rejects(
    provider(fetchImpl, { dialPort: async () => false }).apply(
      deployment(ID),
      version(snapshot({ "index.html": "hi" })),
    ),
    /never listened on port 8080 within 0s; the machine reported no exit event/,
  );
});

test("destroy: deletes the whole Fly app and tolerates one that is already gone", async () => {
  const { fetchImpl, calls } = fakeFly();
  await provider(fetchImpl).destroy(deployment(ID));
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`DELETE /v1/apps/${APP}`],
  );

  const gone = fakeFly({ deleteAppStatus: 404 });
  await provider(gone.fetchImpl).destroy(deployment(ID));
});

test("destroy: a failed deletion surfaces", async () => {
  const { fetchImpl } = fakeFly({ deleteAppStatus: 500 });
  await assert.rejects(provider(fetchImpl).destroy(deployment(ID)), /delete app .*http 500/);
});

test("profile: the core keeps managing idle TTL because 6PN dialing cannot wake a stopped machine", () => {
  const { fetchImpl } = fakeFly();
  assert.deepEqual(provider(fetchImpl).profile, { managedScaleToZero: false });
});

test("missing fly configuration fails at the point of use with the env var that is missing", async () => {
  const { fetchImpl, calls } = fakeFly();
  const missing: Array<[Partial<FlyDeployProviderOptions>, RegExp]> = [
    [{ token: "" }, /FLY_DEPLOY_API_TOKEN not set \(DEPLOY_PROVIDER=fly\)/],
    [{ appPrefix: "" }, /FLY_DEPLOY_APP_PREFIX not set \(DEPLOY_PROVIDER=fly\)/],
    [{ baseImage: "" }, /FLY_DEPLOY_BASE_IMAGE not set \(DEPLOY_PROVIDER=fly\)/],
    [{ org: "" }, /FLY_ORG not set \(DEPLOY_PROVIDER=fly\)/],
  ];
  for (const [over, expected] of missing) {
    await assert.rejects(
      provider(fetchImpl, over).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
      expected,
    );
    await assert.rejects(provider(fetchImpl, over).destroy(deployment(ID)), expected);
  }
  assert.deepEqual(calls, [], "a misconfigured provider never reaches Fly");
});
