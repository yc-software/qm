import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createAgent37DeployProvider } from "../src/deploy/agent37-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { installFakeAgent37, FAKE_AGENT37_API_KEY, type FakeAgent37 } from "./support/fake-agent37.ts";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const scope = scopeId("personal", "tester");

const SERVER_JS = `require('http').createServer((_q, r) => r.end(process.env.API_TOKEN ?? 'ok')).listen(Number(process.env.PORT));\n`;

let fake: FakeAgent37;
let appPort: number;
const roots: string[] = [];

function deployment(extra: Partial<Deployment> = {}): Deployment {
  return {
    id: ID,
    ownerScopeId: scope,
    createdBy: "tester",
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [],
    ...extra,
  } as Deployment;
}

function version(files: Record<string, string>, extra: Partial<DeploymentVersion> = {}): DeploymentVersion {
  const root = mkdtempSync(join(tmpdir(), "a37-deploy-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return {
    version: 1,
    createdAt: Date.now(),
    entrypoint: "node server.js",
    snapshotDir: root,
    ...extra,
  };
}

function make(extra: Record<string, unknown> = {}): DeployProvider {
  return createAgent37DeployProvider({
    apiKey: FAKE_AGENT37_API_KEY,
    fetchImpl: fake.fetchImpl,
    namePrefix: "qmt",
    readyWindowSec: 5,
    appPort,
    store: createMemoryMap(),
    ...extra,
  });
}

beforeEach(async () => {
  fake = installFakeAgent37();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appPort = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  fake?.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("tells qm it manages idleness itself, so qm never reaps an app", () => {
  const provider = make();
  assert.equal(provider.profile.managedScaleToZero, true);
  assert.equal(provider.profile.dataDir, "/data");
});

test("creates the runner template once, with a fixed entrypoint that runs the app's own start script", async () => {
  const provider = make();
  await provider.apply(deployment(), version({ "server.js": SERVER_JS }));

  const templates = fake.templates();
  assert.equal(templates.length, 1);
  const [tpl] = templates;
  assert.equal(tpl!.name, "qm-app-runner");
  assert.equal(tpl!.default_port, null);
  assert.ok(tpl!.entrypoint?.join(" ").includes("/app/.qm-start.sh"));

  await provider.apply(deployment(), version({ "server.js": SERVER_JS }));
  assert.equal(fake.templates().length, 1);
});

test("creates one sleeping instance per app with a public port, and returns its URL", async () => {
  const provider = make();
  const endpoint = await provider.apply(deployment(), version({ "server.js": SERVER_JS }));

  const [name] = fake.names();
  assert.ok(name!.startsWith("qmt-app-550e8400-e29"), `unexpected instance name ${name}`);
  const instance = fake.instance(name!);
  assert.equal(instance?.template, "qm-app-runner");
  assert.deepEqual(instance?.publicPorts, [appPort]);
  assert.equal(instance?.autoSleep, true);

  assert.equal(endpoint.tls, true);
  assert.equal(endpoint.port, 443);
  assert.ok(endpoint.publicUrl?.startsWith("https://pp-"), `unexpected url ${endpoint.publicUrl}`);
});

test("an always-on deployment is created awake", async () => {
  const provider = make();
  await provider.apply(deployment({ alwaysOn: true }), version({ "server.js": SERVER_JS }));
  assert.equal(fake.instance(fake.names()[0]!)?.autoSleep, false);
});

test("setAlwaysOn flips sleeping on the live instance in both directions", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  const name = fake.names()[0]!;

  await provider.setAlwaysOn!(d, true);
  assert.equal(fake.instance(name)?.autoSleep, false);

  await provider.setAlwaysOn!(d, false);
  assert.equal(fake.instance(name)?.autoSleep, true);
});

test("ships the app tree and writes a start script carrying the version's env", async () => {
  const provider = make();
  await provider.apply(
    deployment(),
    version({ "server.js": SERVER_JS, "lib/util.js": "" }, { env: { API_TOKEN: "t0ken", "bad name": "dropped" } }),
  );

  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "t0ken");
});

test("republishing replaces files on the same instance and applies always-on", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS, "gone.txt": "old" }));
  const before = fake.names()[0]!;
  const next = version({ "server.js": SERVER_JS }, { env: { API_TOKEN: "updated" } });
  await provider.apply({ ...d, alwaysOn: true }, next);
  assert.deepEqual(fake.names(), [before]);
  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "updated");
  assert.equal(fake.instance(before)?.autoSleep, false);
});

test("destroy deletes the instance and resolveEndpoint then reports nothing", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  assert.equal(fake.names().length, 1);

  const v = version({ "server.js": SERVER_JS });
  assert.ok(await provider.resolveEndpoint!(d, v));
  await provider.destroy(d);
  assert.equal(fake.names().length, 0);
  assert.equal(await provider.resolveEndpoint!(d, v), null);

  await provider.destroy(d);
});

test("logs tail the app's output, and are null once the instance is gone", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  assert.equal(typeof (await provider.logs!(d, { tailLines: 10 })), "string");

  await provider.destroy(d);
  assert.equal(await provider.logs!(d, { tailLines: 10 }), null);
});

test("a create that never comes up leaves no orphan instance behind", async () => {
  const provider = make();
  fake.failNext(500, { match: ({ path }) => path.endsWith("/exec") });
  await assert.rejects(provider.apply(deployment(), version({ "server.js": SERVER_JS })));
  assert.deepEqual(fake.names(), []);
});

test("refuses to construct without an API key", () => {
  assert.throws(() => createAgent37DeployProvider({}), /AGENT37_DEPLOY_API_KEY/);
});

test("ordinary publish, Git-backed redeploy and rollback serve their selected version", async () => {
  const deployDir = mkdtempSync(join(tmpdir(), "a37-service-"));
  roots.push(deployDir);
  const service = createDeployService({
    deployStore: createDeployStore(),
    provider: make(),
    acl: createAclStore(),
    deployDir,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
  });
  const d = await service.deploy({
    ownerScopeId: scope,
    createdBy: "tester",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: SERVER_JS }],
    env: { API_TOKEN: "first" },
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "first");
  const before = fake.names()[0]!;
  await service.redeploy(d.id, {
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: SERVER_JS.replace("'ok'", "'second'") }],
    env: {},
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "second");
  await service.rollbackDeployment(d.id, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "first");
  assert.deepEqual(fake.names(), [before]);
});

test("a new provider recovers a tagged instance after losing its local pointer", async () => {
  const d = deployment();
  await make().apply(d, version({ "server.js": SERVER_JS }));
  const before = fake.names()[0]!;
  const recovered = make();
  await recovered.apply(d, version({ "server.js": SERVER_JS }, { env: { API_TOKEN: "recovered" } }));
  assert.deepEqual(fake.names(), [before]);
  assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(), "recovered");
  await make().destroy(d);
  assert.deepEqual(fake.names(), []);
});
