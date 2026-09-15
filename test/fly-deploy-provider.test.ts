import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import { createMemoryMap } from "../src/persistence/durable-map.ts";

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
  updateLeavesStopped?: boolean;
  loseFirstCreateResponse?: boolean;
  createAppStatus?: number;
  createAppBody?: string;
  existingApp?: { name: string; network: string; organization: { slug: string } };
  ips?: string[];
  ingressNetwork?: string;
  networkPolicies?: unknown[];
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
  const configs = new Map<string, FlyMachineConfig>();
  const volumes: Array<{ id: string; name: string; region: string }> = [];
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
    if (segments[3] === "ip_assignments" && method === "GET")
      return json(200, {
        ips: ips.map((ip) => ({ ip, network: { name: opts.ingressNetwork ?? "trusted-ingress", org_slug: ORG } })),
      });
    if (segments[3] === "network_policies" && method === "GET")
      return json(
        200,
        opts.networkPolicies ?? [
          {
            netpolSelector: { all: true },
            rules: [{ action: "allow", direction: "ingress", ports: [{ protocol: "tcp", port: 22 }] }],
          },
        ],
      );
    if (segments[3] === "ip_assignments" && method === "POST") {
      ips.push("fdaa:1:2:3::1");
      return json(201, { ip: ips[0] });
    }
    if (segments[3] === "volumes" && method === "GET") return json(200, volumes);
    if (segments[3] === "volumes" && method === "POST") {
      const body = JSON.parse(String(init.body));
      const volume = { id: `volume-${volumes.length + 1}`, name: body.name, region: body.region };
      volumes.push(volume);
      return json(201, volume);
    }
    if (method === "GET" && segments.length === 4)
      return json(
        200,
        [...machines.keys()].map((id) => ({ id, state: machines.get(id), config: configs.get(id) })),
      );
    if (method === "POST" && segments.length === 4) {
      const id = `machine-${++created}`;
      machines.set(id, "created");
      configs.set(id, JSON.parse(String(init.body)).config);
      cordoned.add(id);
      if (opts.loseFirstCreateResponse && created === 1) throw new Error("create response lost");
      return json(200, { id, state: "created" });
    }
    const machineId = segments[4] ?? "";
    if (method === "POST" && segments.length === 5) {
      configs.set(machineId, JSON.parse(String(init.body)).config);
      return json(200, { id: machineId, state: opts.updateLeavesStopped ? "stopped" : "started" });
    }
    if (method === "POST" && segments.length === 6 && segments[5] === "start") {
      machines.set(machineId, "started");
      return json(200, { id: machineId, state: "started" });
    }
    if (method === "GET" && segments.length === 5) {
      if (!machines.has(machineId)) return json(404, { error: "not found" });
      const state = nextState();
      machines.set(machineId, state);
      return json(200, {
        id: machineId,
        state,
        config: configs.get(machineId),
        checks: [{ name: "app", status: configs.get(machineId)?.env.BROKEN === "1" ? "failing" : nextCheck() }],
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
  return { fetchImpl, calls, machines, cordoned, configs, volumes };
}

function provider(fetchImpl: typeof fetch, extra: Partial<FlyDeployProviderOptions> = {}) {
  return createFlyDeployProvider({
    token: TOKEN,
    appPrefix: PREFIX,
    baseImage: IMAGE,
    org: ORG,
    configStore: createMemoryMap<FlyMachineConfig>(),
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
      autostop: "suspend",
      autostart: true,
      min_machines_running: 0,
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

test("apply: keeps an always-on deployment running under Fly managed lifecycle", async () => {
  const { fetchImpl, calls } = fakeFly();
  await provider(fetchImpl).apply({ ...deployment(ID), alwaysOn: true }, version(snapshot({ "server.js": "" })));
  const { config } = machineCreate(calls);
  assert.equal(config.services[0]!.min_machines_running, 1);
  assert.equal(config.services[0]!.autostart, true);
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
    [`GET /v1/apps/${APP}`, `GET /v1/apps/${APP}/volumes`, `DELETE /v1/apps/${APP}`],
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

test("profile: shared Flycast manages suspension while existing standalone apps retain idle cleanup", () => {
  const { fetchImpl } = fakeFly();
  assert.deepEqual(provider(fetchImpl).profile, { managedScaleToZero: false });
  assert.deepEqual(provider(fetchImpl, { sharedAppName: "company-app" }).profile, { managedScaleToZero: true });
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

test("durable apply retains one volume across updates, rollback, archive and recreation", async () => {
  const fake = fakeFly();
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1, appReadyTimeoutMs: 10 });
  const d = deployment(ID);
  const first = version(snapshot({ "server.js": "first" }));
  await deploy.apply(d, first);
  const original = structuredClone(fake.configs.get("machine-1")!);
  assert.deepEqual(original.mounts, [{ volume: "volume-1", path: "/data" }]);
  assert.equal(original.env.DATA_DIR, "/data");
  assert.equal(deploy.profile.dataDir, "/data");
  await deploy.apply(d, version(snapshot({ "server.js": "second" }), { version: 2 }));
  assert.deepEqual([...fake.machines.keys()], ["machine-1"]);
  assert.deepEqual(fake.configs.get("machine-1")!.mounts, original.mounts);
  const working = structuredClone(fake.configs.get("machine-1")!);
  await assert.rejects(
    deploy.apply(d, version(snapshot({ "server.js": "broken" }), { env: { BROKEN: "1" } })),
    /never listened/,
  );
  assert.deepEqual(fake.configs.get("machine-1"), working);
  await deploy.destroy(d);
  assert.equal(fake.machines.size, 0);
  assert.equal(fake.volumes.length, 1);
  assert.equal(
    fake.calls.some((c) => c.method === "DELETE" && c.path === `/v1/apps/${APP}`),
    false,
  );
  await deploy.apply(d, first);
  assert.deepEqual(fake.configs.get("machine-2")!.mounts, original.mounts);
  assert.equal(fake.volumes.length, 1);
});

test("durable apply refuses to replace an existing ephemeral machine", async () => {
  const fake = fakeFly({ existingMachines: ["old"] });
  await assert.rejects(
    provider(fake.fetchImpl, { dataVolumeSizeGb: 1 }).apply(
      deployment(ID),
      version(snapshot({ "server.js": "first" })),
    ),
    /explicit migration/,
  );
  assert.deepEqual([...fake.machines.keys()], ["old"]);
  assert.equal(fake.volumes.length, 0);
});

test("durable retry restores routing after an accepted create loses its response", async () => {
  const fake = fakeFly({ loseFirstCreateResponse: true });
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1 });
  const d = deployment(ID),
    v = version(snapshot({ "server.js": "app" }));
  await assert.rejects(deploy.apply(d, v), /create response lost/);
  assert.equal(fake.cordoned.has("machine-1"), true);
  await deploy.apply(d, v);
  assert.equal(fake.cordoned.has("machine-1"), false);
  assert.equal(fake.machines.size, 1);
});

test("missing volume configuration cannot downgrade or destroy durable storage", async () => {
  const fake = fakeFly();
  const d = deployment(ID),
    v = version(snapshot({ "server.js": "app" }));
  await provider(fake.fetchImpl, { dataVolumeSizeGb: 1 }).apply(d, v);
  const missing = provider(fake.fetchImpl);
  await assert.rejects(missing.apply(d, v), /restore FLY_DEPLOY_DATA_VOLUME_SIZE_GB/);
  assert.equal(fake.machines.size, 1);
  await missing.destroy(d);
  assert.equal(fake.volumes.length, 1);
  assert.equal(
    fake.calls.some((c) => c.method === "DELETE" && c.path === `/v1/apps/${APP}`),
    false,
  );
});

test("durable rollback uses the accepted configuration after a provider restart", async () => {
  const fake = fakeFly();
  const configStore = createMemoryMap<FlyMachineConfig>();
  const opts = { dataVolumeSizeGb: 1, configStore, appReadyTimeoutMs: 10 };
  const d = deployment(ID),
    good = version(snapshot({ "server.js": "good" }));
  await provider(fake.fetchImpl, opts).apply(d, good);
  const accepted = structuredClone(fake.configs.get("machine-1")!);
  fake.configs.set("machine-1", { ...accepted, env: { BROKEN: "1" } });
  const restarted = provider(fake.fetchImpl, opts);
  await assert.rejects(
    restarted.apply(d, version(snapshot({ "server.js": "bad" }), { env: { BROKEN: "1" } })),
    /never listened/,
  );
  assert.deepEqual(fake.configs.get("machine-1"), accepted);
});

test("always-on toggles update an existing machine without replacing its data", async () => {
  const fake = fakeFly();
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1 });
  const d = deployment(ID);
  await deploy.apply(d, version(snapshot({ "server.js": "app" })));
  for (const alwaysOn of [true, false]) {
    await deploy.setAlwaysOn!(d, alwaysOn);
    assert.equal(fake.configs.get("machine-1")!.services[0]!.min_machines_running, alwaysOn ? 1 : 0);
    assert.deepEqual(fake.configs.get("machine-1")!.mounts, [{ volume: "volume-1", path: "/data" }]);
    assert.equal(fake.machines.size, 1);
  }
});

test("always-on toggles preserve the latest ephemeral publication after a prior toggle", async () => {
  const fake = fakeFly();
  const deploy = provider(fake.fetchImpl);
  const d = deployment(ID);
  await deploy.apply(d, version(snapshot({ "server.js": "first" })));
  await deploy.setAlwaysOn!(d, true);
  await deploy.apply({ ...d, alwaysOn: true }, version(snapshot({ "server.js": "second" }), { version: 2 }));
  const current = structuredClone(fake.configs.get("machine-2")!);
  await deploy.setAlwaysOn!(d, false);
  assert.deepEqual(fake.configs.get("machine-2"), {
    ...current,
    services: current.services.map((service) => ({ ...service, min_machines_running: 0 })),
  });
});

test("an update that leaves the machine stopped explicitly starts it", async () => {
  const fake = fakeFly({ updateLeavesStopped: true });
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1 });
  const d = deployment(ID),
    v = version(snapshot({ "server.js": "app" }));
  await deploy.apply(d, v);
  await deploy.setAlwaysOn!(d, true);
  assert.ok(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/machines/machine-1/start")));
});

test("configuration-store failure rolls back an updated machine", async () => {
  const fake = fakeFly();
  const configStore = createMemoryMap<FlyMachineConfig>();
  const put = configStore.put.bind(configStore);
  let writes = 0;
  configStore.put = async (id, value) => {
    if (++writes === 2) throw new Error("store unavailable");
    await put(id, value);
  };
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1, configStore });
  const d = deployment(ID),
    v = version(snapshot({ "server.js": "first" }));
  await deploy.apply(d, v);
  const accepted = structuredClone(fake.configs.get("machine-1"));
  await assert.rejects(deploy.apply(d, version(snapshot({ "server.js": "second" }))), /store unavailable/);
  assert.deepEqual(fake.configs.get("machine-1"), accepted);
  assert.deepEqual(await configStore.get(d.id), accepted);
});

test("always-on uses the accepted configuration after an interrupted update", async () => {
  const fake = fakeFly();
  const deploy = provider(fake.fetchImpl, { dataVolumeSizeGb: 1 });
  const d = deployment(ID);
  await deploy.apply(d, version(snapshot({ "server.js": "good" })));
  const accepted = structuredClone(fake.configs.get("machine-1")!);
  fake.configs.set("machine-1", { ...accepted, env: { BROKEN: "1" } });
  await deploy.setAlwaysOn!(d, true);
  assert.deepEqual(fake.configs.get("machine-1")!.env, accepted.env);
});

test("shared app updates and archives only the owning deployment", async () => {
  const fake = fakeFly({
    existingApp: { name: "company-app", network: "company-app", organization: { slug: ORG } },
    ips: ["fdaa:1:2:3::1"],
  });
  const portStore = createMemoryMap<string>();
  const configStore = createMemoryMap<FlyMachineConfig>();
  const options = { sharedAppName: "company-app", portStore, configStore, dataVolumeSizeGb: 1 };
  const deploy = provider(fake.fetchImpl, options);
  const a = deployment(ID),
    b = deployment("other-deployment");
  const v = version(snapshot({ "server.js": "good" }));
  const ea = await deploy.apply(a, v),
    eb = await deploy.apply(b, v);
  assert.equal(ea.host, eb.host);
  assert.notEqual(ea.port, eb.port);
  assert.equal(fake.volumes.length, 2);
  const sibling = structuredClone(fake.configs.get("machine-2"));
  assert.deepEqual(await provider(fake.fetchImpl, options).apply(a, v), ea);
  await deploy.setAlwaysOn!(a, true);
  assert.deepEqual(fake.configs.get("machine-2"), sibling);
  await deploy.destroy(a);
  assert.deepEqual([...fake.machines.keys()], ["machine-2"]);
  assert.equal(fake.volumes.length, 2);
  assert.equal(
    fake.calls.some((call) => call.method === "DELETE" && call.path === "/v1/apps/company-app"),
    false,
  );
  assert.deepEqual(await deploy.apply(a, v), ea);
  assert.equal(fake.volumes.length, 2);
});

test("shared app refuses missing durable port ownership before API calls", async () => {
  const fake = fakeFly();
  await assert.rejects(
    provider(fake.fetchImpl, { sharedAppName: "company-app", dataVolumeSizeGb: 1 }).apply(
      deployment(ID),
      version(snapshot({})),
    ),
    /persistent port assignments/,
  );
  assert.equal(fake.calls.length, 0);
});

test("shared ports preserve an existing owner's claim and survive provider recreation", async () => {
  const fake = fakeFly({
    existingApp: { name: "company-app", network: "company-app", organization: { slug: ORG } },
    ips: ["fdaa:1:2:3::1"],
  });
  const portStore = createMemoryMap<string>();
  const first = 20000 + (createHash("sha256").update(ID).digest().readUInt32BE(0) % 45536);
  await portStore.put(`company-app:${first}`, "existing-owner");
  const options = {
    sharedAppName: "company-app",
    portStore,
    configStore: createMemoryMap<FlyMachineConfig>(),
    dataVolumeSizeGb: 1,
  };
  const d = deployment(ID),
    v = version(snapshot({ "server.js": "good" }));
  const endpoint = await provider(fake.fetchImpl, options).apply(d, v);
  assert.notEqual(endpoint.port, first);
  assert.equal(await portStore.get(`company-app:${first}`), "existing-owner");
  assert.deepEqual(await provider(fake.fetchImpl, options).apply(d, v), endpoint);
});

test("shared publishing requires pre-provisioned app and ingress without creating either", async () => {
  for (const existing of [false, true]) {
    const fake = fakeFly(
      existing ? { existingApp: { name: "company-app", network: "company-app", organization: { slug: ORG } } } : {},
    );
    const deploy = provider(fake.fetchImpl, {
      appPrefix: "",
      sharedAppName: "company-app",
      portStore: createMemoryMap<string>(),
      dataVolumeSizeGb: 1,
    });
    await assert.rejects(deploy.apply(deployment(ID), version(snapshot({}))), /provisioned before publishing/);
    assert.equal(
      fake.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("private transport is restored when resolving a persisted endpoint", async () => {
  const fake = fakeFly();
  let connections = 0;
  const deploy = provider(fake.fetchImpl, {
    privateTransport: {
      ensure: async () => {
        connections++;
        return 18096;
      },
    },
  });
  const d = deployment(ID);
  const endpoint = await deploy.apply(d, version(snapshot({ "server.js": "app" })));
  assert.equal(endpoint.socksProxyPort, 18096);
  assert.deepEqual(await deploy.resolveEndpoint!({ ...d, endpoint }, version(snapshot({}))), endpoint);
  assert.equal(connections, 2);
});

test("shared publishing rejects missing or permissive ingress isolation before creating resources", async () => {
  for (const overrides of [
    { ingressNetwork: "" },
    { ingressNetwork: "default" },
    { ingressNetwork: "company-app" },
    { networkPolicies: [] },
    {
      networkPolicies: [
        {
          netpolSelector: { all: true, metadata: { role: "not-qm" } },
          rules: [{ action: "allow", direction: "ingress", ports: [{ protocol: "tcp", port: 22 }] }],
        },
      ],
    },
    {
      networkPolicies: [
        {
          netpolSelector: { all: false },
          rules: [{ action: "allow", direction: "ingress", ports: [{ protocol: "tcp", port: 22 }] }],
        },
      ],
    },
    {
      networkPolicies: [
        {
          netpolSelector: { all: true },
          rules: [{ action: "allow", direction: "ingress", ports: [{ protocol: "tcp", port: 8080 }] }],
        },
      ],
    },
  ]) {
    const fake = fakeFly({
      existingApp: { name: "company-app", network: "company-app", organization: { slug: ORG } },
      ips: ["fdaa:1:2:3::1"],
      ...overrides,
    });
    const deploy = provider(fake.fetchImpl, {
      sharedAppName: "company-app",
      portStore: createMemoryMap<string>(),
      dataVolumeSizeGb: 1,
    });
    await assert.rejects(
      deploy.apply(deployment(ID), version(snapshot({ "index.html": "hi" }))),
      /requires.*(private network|ingress restricted)/,
    );
    assert.ok(fake.calls.every((call) => call.method === "GET"));
  }
});
