import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2bDeployProvider, type StoredE2bDeployBody } from "../src/deploy/e2b-deploy-provider.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";
import { installFakeE2b, type FakeE2b } from "./support/fake-e2b.ts";
import { singleProcessDeps } from "./support/single-process.ts";

const SERVER = [
  "const fs = require('fs');",
  "require('http').createServer((q, s) => {",
  "  s.setHeader('connection', 'close');",
  "  if (q.url === '/write') { fs.writeFileSync(process.env.DATA_DIR + '/note.txt', 'kept'); return s.end('ok'); }",
  "  if (q.url === '/data') return s.end(fs.readFileSync(process.env.DATA_DIR + '/note.txt', 'utf8'));",
  "  s.end('v' + process.env.APP_VERSION);",
  "}).listen(process.env.PORT, '127.0.0.1');",
].join(" ");

let fake: FakeE2b | undefined;
let appPort = 0;

afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const deployment = (id: string, extra: Partial<Deployment> = {}): Deployment => ({
  id,
  ownerScopeId: scopeId("personal", "tester"),
  createdBy: "tester",
  currentVersion: 1,
  status: "running",
  endpoint: null,
  versions: [],
  ...extra,
});

function version(appVersion: string, entrypoint = "node server.js"): DeploymentVersion {
  const snapshotDir = mkdtempSync(join(tmpdir(), "e2b-deploy-snap-"));
  writeFileSync(join(snapshotDir, "server.js"), SERVER);
  return { version: 1, createdAt: Date.now(), entrypoint, snapshotDir, env: { APP_VERSION: appVersion } };
}

async function make(): Promise<{ provider: DeployProvider; store: DurableMap<StoredE2bDeployBody>; fake: FakeE2b }> {
  appPort = await freePort();
  fake = installFakeE2b({ info: true });
  const store = createMemoryMap<StoredE2bDeployBody>();
  const provider = createE2bDeployProvider({
    ...singleProcessDeps(),
    client: fake.client,
    namePrefix: "qmt",
    appPort,
    readyWindowSec: 10,
    idleTimeoutSec: 300,
    resolveCacheMs: 0,
    store,
  });
  return { provider, store, fake };
}

const get = async (path: string): Promise<string> => (await fetch(`http://127.0.0.1:${appPort}${path}`)).text();

test("e2b deploy runs each app in its own auto-pausing, auto-resuming private sandbox", async () => {
  const { provider, fake } = await make();
  const d = deployment("dep-aaaaaaaaaaaa");
  const endpoint = await provider.apply(d, version("1"));
  const name = "qmt-app-dep-aaaaaaaa";
  const sandboxId = fake.current(name)!.sandboxId;
  assert.deepEqual(endpoint, {
    host: `${appPort}-${sandboxId}.e2b.test`,
    port: 443,
    tls: true,
    proxyHeaders: { "e2b-traffic-access-token": `traffic-${sandboxId}` },
  });
  assert.deepEqual(fake.createOptions(name), {
    autoPause: true,
    autoResume: true,
    privateTraffic: true,
    timeoutMs: 300_000,
  });
  assert.equal(fake.current(name)!.metadata["qm-deploy"], d.id);
  assert.equal(await get("/"), "v1");
  assert.equal(provider.profile.managedScaleToZero, true);
});

test("e2b deploy updates in place, keeping the sandbox and its data directory", async () => {
  const { provider, fake } = await make();
  const d = deployment("dep-bbbbbbbbbbbb");
  const first = await provider.apply(d, version("1"));
  assert.equal(await get("/write"), "ok");
  const second = await provider.apply(d, version("2"));
  assert.deepEqual(second, first);
  assert.equal(fake.createdCount("qmt-app-dep-bbbbbbbb"), 1);
  assert.equal(await get("/"), "v2");
  assert.equal(await get("/data"), "kept");
});

test("e2b deploy resolves a paused app without waking it and forgets a killed one", async () => {
  const { provider, store, fake } = await make();
  const d = deployment("dep-cccccccccccc");
  const endpoint = await provider.apply(d, version("1"));
  const name = "qmt-app-dep-cccccccc";
  fake.pause(name);
  assert.deepEqual(await provider.resolveEndpoint!(d, version("1")), endpoint);
  assert.equal(fake.current(name)!.state, "paused");
  await fake.client.kill(fake.current(name)!.sandboxId);
  assert.equal(await provider.resolveEndpoint!(d, version("1")), null);
  assert.equal(await store.get(d.id), null);
});

test("e2b deploy kills the sandbox when the app never listens", async () => {
  const { provider, fake } = await make();
  const d = deployment("dep-dddddddddddd");
  await assert.rejects(provider.apply(d, version("1", "echo boom; exit 3")), /exited without binding port[\s\S]*boom/);
  assert.equal(fake.current("qmt-app-dep-dddddddd"), null);
});

test("e2b deploy keeps always-on apps up for the longest timeout and destroys cleanly", async () => {
  const { provider, store, fake } = await make();
  const d = deployment("dep-eeeeeeeeeeee", { alwaysOn: true });
  await provider.apply(d, version("1"));
  const name = "qmt-app-dep-eeeeeeee";
  assert.equal(fake.createOptions(name).timeoutMs, 24 * 3600_000);
  await provider.destroy(d);
  assert.equal(fake.current(name), null);
  assert.equal(await store.get(d.id), null);
});
