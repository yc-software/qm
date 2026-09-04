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
const IMAGE = "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const ORG = "acme";
const ID = "550e8400-e29b-41d4-a716-446655440000";
const APP = `${PREFIX}-${ID}`;
const OWNED_APP = { name: APP, network: APP, organization: { slug: ORG } };

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
  existingApp?: { name: string; network: string; organization: { slug: string } };
  ips?: string[];
  deleteAppStatus?: number;
  existingMachines?: string[];
  states?: string[];
  checkStates?: string[];
  events?: FlyMachine["events"];
  destroyMachineStatus?: number;
  cordonStatus?: number;
  cordonFailsAfterApply?: boolean;
  uncordonStatus?: number;
}

function fakeFly(opts: FakeFlyOptions = {}) {
  const calls: FlyCall[] = [];
  const machines = new Map<string, string>();
  for (const id of opts.existingMachines ?? []) machines.set(id, "started");
  const states = [...(opts.states ?? ["started"])];
  const checkStates = [...(opts.checkStates ?? ["passing"])];
  const nextState = (): string => (states.length > 1 ? states.shift()! : (states[0] ?? "started"));
  const nextCheck = (): string => (checkStates.length > 1 ? checkStates.shift()! : (checkStates[0] ?? "passing"));
  const ips = [...(opts.ips ?? [])];
  const cordoned = new Set<string>();
  let app = opts.existingApp;
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
    if (method === "POST" && segments.length === 2) {
      const body = JSON.parse(String(init.body)) as { app_name: string; network: string; org_slug: string };
      if ((opts.createAppStatus ?? 201) < 300) {
        app = { name: body.app_name, network: body.network, organization: { slug: body.org_slug } };
      }
      return new Response(opts.createAppBody ?? "{}", { status: opts.createAppStatus ?? 201 });
    }
    if (method === "GET" && segments.length === 3) return app ? json(200, app) : json(404, { error: "not found" });
    if (method === "DELETE" && segments.length === 3) {
      app = undefined;
      return new Response("{}", { status: opts.deleteAppStatus ?? 202 });
    }
    if (segments[3] === "ip_assignments" && method === "GET") return json(200, { ips: ips.map((ip) => ({ ip })) });
    if (segments[3] === "ip_assignments" && method === "POST") {
      ips.push("fdaa:1:2:3::1");
      return json(201, { ip: ips[0] });
    }
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
      return json(200, {
        id: machineId,
        state,
        checks: [{ name: "app", status: nextCheck() }],
        ...(opts.events ? { events: opts.events } : {}),
      });
    }
    if (method === "POST" && segments.length === 6 && segments[5] === "cordon") {
      if ((opts.cordonStatus ?? 200) < 300) cordoned.add(machineId);
      if (opts.cordonFailsAfterApply) throw new Error("connection lost after cordon");
      return json(opts.cordonStatus ?? 200, {});
    }
    if (method === "POST" && segments.length === 6 && segments[5] === "uncordon") {
      const status = machineId === "machine-1" ? (opts.uncordonStatus ?? 200) : 200;
      if (status < 300) cordoned.delete(machineId);
      return json(status, {});
    }
    if (method === "DELETE" && segments.length === 5) {
      if ((opts.destroyMachineStatus ?? 200) < 300) {
        machines.delete(machineId);
        cordoned.delete(machineId);
      }
      return json(opts.destroyMachineStatus ?? 200, {});
    }
    return json(500, { error: `unexpected ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, machines, cordoned };
}

function provider(fetchImpl: typeof fetch, extra: Partial<FlyDeployProviderOptions> = {}) {
  return createFlyDeployProvider({
    token: TOKEN,
    appPrefix: PREFIX,
    baseImage: IMAGE,
    org: ORG,
    fetchImpl,
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

const machineCreate = (
  calls: FlyCall[],
): { region: string; config: FlyMachineConfig; skip_service_registration: true } =>
  calls.find((c) => c.method === "POST" && c.path.endsWith("/machines"))!.body as unknown as {
    region: string;
    config: FlyMachineConfig;
    skip_service_registration: true;
  };

test("apply: creates an isolated Fly app, injects the snapshot, and returns private Flycast ingress", async () => {
  const { fetchImpl, calls } = fakeFly();
  const endpoint = await provider(fetchImpl).apply(
    deployment(ID),
    version(snapshot({ "index.html": "<h1>hi</h1>", "lib/util.js": "export const x = 1;" })),
  );

  assert.deepEqual(endpoint, { host: `${APP}.flycast`, port: 8080 });
  assert.equal(endpoint.tls, undefined, "Flycast dialing is plaintext — the proxy must not attempt TLS");
  assert.equal(endpoint.httpVersion, undefined, "the core proxy defaults to HTTP/1.1");

  const createApp = calls.find((c) => c.method === "POST" && c.path === "/v1/apps")!;
  assert.deepEqual(createApp.body, { app_name: APP, org_slug: ORG, network: APP });
  assert.equal(createApp.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(calls.find((c) => c.method === "POST" && c.path.endsWith("/ip_assignments"))!.body, {
    type: "private_v6",
  });

  const { region, config, skip_service_registration } = machineCreate(calls);
  assert.equal(region, "lhr");
  assert.equal(skip_service_registration, true);
  assert.equal(config.image, IMAGE);
  assert.deepEqual(config.env, { API_KEY: "secret", PORT: "8080" });
  assert.deepEqual(config.guest, { cpu_kind: "shared", cpus: 1, memory_mb: 512 });
  assert.deepEqual(config.services, [
    {
      protocol: "tcp",
      internal_port: 8080,
      ports: [{ port: 8080 }],
      checks: [{ type: "tcp", interval: "2s", timeout: "1s", grace_period: "1s" }],
    },
  ]);
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

test("apply: refuses a pre-existing public IP before creating a machine", async () => {
  const unsafe = fakeFly({ createAppStatus: 422, existingApp: OWNED_APP, ips: ["2a09:8280:1::1"] });
  await assert.rejects(
    provider(unsafe.fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /public IP assignment; refusing to expose/,
  );
  assert.ok(!unsafe.calls.some((c) => c.path.endsWith("/machines")), "an unsafe app never gets a machine");
});

test("apply: an app that already exists is not an error", async () => {
  for (const over of [
    { createAppStatus: 409, existingApp: OWNED_APP },
    { createAppStatus: 422, createAppBody: '{"error":"Name has already been taken"}', existingApp: OWNED_APP },
  ]) {
    const { fetchImpl } = fakeFly(over);
    const endpoint = await provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));
    assert.deepEqual(endpoint, { host: `${APP}.flycast`, port: 8080 });
  }
});

test("apply: a name conflict is reused only when its organization and isolated network match", async () => {
  for (const existingApp of [
    { ...OWNED_APP, network: "default" },
    { ...OWNED_APP, organization: { slug: "someone-else" } },
  ]) {
    const { fetchImpl, calls } = fakeFly({ createAppStatus: 422, existingApp });
    await assert.rejects(
      provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
      /not the isolated app owned by this deployment/,
    );
    assert.ok(!calls.some((c) => c.path.endsWith("/machines")));
  }
});

test("apply: a rejected app creation still surfaces", async () => {
  const { fetchImpl } = fakeFly({ createAppStatus: 401, createAppBody: '{"error":"unauthorized"}' });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /create app .*http 401.*unauthorized/,
  );
});

test("apply: the previous version stays up until its healthy replacement is ready", async () => {
  const { fetchImpl, calls, machines } = fakeFly({ existingMachines: ["machine-old"] });
  await provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));

  const destroyIndex = calls.findIndex((c) => c.method === "DELETE" && c.path.endsWith("/machines/machine-old"));
  const createIndex = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/machines"));
  const cordonIndex = calls.findIndex((c) => c.path.endsWith("/machines/machine-old/cordon"));
  const uncordonIndex = calls.findIndex((c) => c.path.endsWith("/machines/machine-1/uncordon"));
  assert.ok(destroyIndex >= 0, "the stale machine is destroyed");
  assert.ok(createIndex < cordonIndex && cordonIndex < uncordonIndex && uncordonIndex < destroyIndex);
  assert.equal(calls[destroyIndex]!.query, "?force=true");
  assert.deepEqual([...machines.keys()], ["machine-1"]);
});

test("apply: a failed stale cleanup leaves the old machine cordoned, never mixed into traffic", async () => {
  const fake = fakeFly({ existingMachines: ["machine-old"], destroyMachineStatus: 500 });
  const logged = console.warn;
  console.warn = () => {};
  try {
    await provider(fake.fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" })));
  } finally {
    console.warn = logged;
  }
  assert.deepEqual([...fake.machines.keys()], ["machine-old", "machine-1"]);
  assert.deepEqual([...fake.cordoned], ["machine-old"]);
});

test("apply: a failed cutover restores the old route and removes the replacement", async () => {
  for (const status of [404, 500]) {
    const fake = fakeFly({ existingMachines: ["machine-old"], uncordonStatus: status });
    await assert.rejects(
      provider(fake.fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
      new RegExp(`uncordon machine machine-1.*http ${status}`),
    );
    assert.deepEqual([...fake.machines.keys()], ["machine-old"]);
    assert.deepEqual([...fake.cordoned], []);
  }
});

test("apply: rollback restores an old route when the cordon response is lost", async () => {
  const fake = fakeFly({ existingMachines: ["machine-old"], cordonFailsAfterApply: true });
  await assert.rejects(
    provider(fake.fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /connection lost after cordon/,
  );
  assert.deepEqual([...fake.machines.keys()], ["machine-old"]);
  assert.deepEqual([...fake.cordoned], []);
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

test("apply: highly compressible source cannot bypass the unpacked-size cap", async () => {
  const { fetchImpl, calls } = fakeFly();
  const big = snapshot({ "zeros.bin": Buffer.alloc(20_000_001) });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(big)),
    /app source is too large.*20000001 bytes, maximum 20000000 bytes/,
  );
  assert.deepEqual(calls, []);
});

test("apply: a machine that never starts reports its last state", async () => {
  const { fetchImpl, machines } = fakeFly({ existingMachines: ["machine-old"], states: ["created"] });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /never reached state "started" within 0s \(last state: created\)/,
  );
  assert.deepEqual(
    [...machines.keys()],
    ["machine-old"],
    "a failed replacement is removed without touching the live version",
  );
});

test("apply: an entrypoint that exits without binding the port reports why, with the machine's exit event", async () => {
  const { fetchImpl } = fakeFly({
    states: ["started", "stopped"],
    checkStates: ["critical"],
    events: [{ request: { exit_event: { exit_code: 127, oom_killed: false } } }],
  });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /entrypoint exited without binding port 8080 \(fly machine machine-1 is stopped\).*exit code 127/s,
  );
});

test("apply: an app that stays up but never passes its service check reports the readiness window", async () => {
  const { fetchImpl } = fakeFly({ checkStates: ["critical"] });
  await assert.rejects(
    provider(fetchImpl).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
    /never listened on port 8080 within 0s; the machine reported no exit event/,
  );
});

test("destroy: deletes the whole Fly app and tolerates one that is already gone", async () => {
  const { fetchImpl, calls } = fakeFly({ existingApp: OWNED_APP });
  await provider(fetchImpl).destroy(deployment(ID));
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`GET /v1/apps/${APP}`, `DELETE /v1/apps/${APP}`],
  );
  assert.equal(calls.at(-1)!.query, "?force=true");

  const gone = fakeFly({ deleteAppStatus: 404 });
  await provider(gone.fetchImpl).destroy(deployment(ID));
});

test("destroy: refuses a mismatched app and surfaces a failed deletion", async () => {
  const mismatched = fakeFly({ existingApp: { ...OWNED_APP, network: "default" } });
  await assert.rejects(provider(mismatched.fetchImpl).destroy(deployment(ID)), /not the isolated app owned/);
  assert.ok(!mismatched.calls.some((c) => c.method === "DELETE"));

  const { fetchImpl } = fakeFly({ existingApp: OWNED_APP, deleteAppStatus: 500 });
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

test("an invalid app prefix fails before reaching Fly", async () => {
  const { fetchImpl, calls } = fakeFly();
  for (const appPrefix of ["Bad_Prefix", "a".repeat(27)]) {
    await assert.rejects(
      provider(fetchImpl, { appPrefix }).apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
      /FLY_DEPLOY_APP_PREFIX must be a lowercase DNS label no longer than 26 characters/,
    );
  }
  assert.deepEqual(calls, []);
});
