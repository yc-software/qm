import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "../src/deploy/porter-deploy-provider.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { NotFoundError } from "porter-sandbox";
import { scopeId } from "../src/types.ts";
import { installFakePorter, type FakePorter } from "./support/fake-porter.ts";

const SERVER = [
  "const fs = require('fs');",
  "console.log('server starting');",
  "require('http').createServer((q, s) => {",
  "  s.setHeader('connection', 'close');",
  "  if (q.url === '/data') return s.end(fs.readFileSync(process.env.DATA_DIR + '/note.txt', 'utf8'));",
  "  s.end('hello from ' + process.cwd() + ' v' + (process.env.APP_VERSION ?? '?'));",
  "}).listen(process.env.PORT);",
].join(" ");

let fake: FakePorter;
let store: DurableMap<StoredPorterDeployBody>;
let provider: DeployProvider;
let appPort: number;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const deployment = (id: string, name?: string): Deployment => ({
  id,
  ownerScopeId: scopeId("personal", "tester"),
  createdBy: "tester",
  currentVersion: 1,
  status: "running",
  endpoint: null,
  versions: [],
  ...(name ? { name } : {}),
});

function version(
  files: Record<string, string>,
  entrypoint: string,
  extra: Partial<DeploymentVersion> = {},
): DeploymentVersion {
  const snapshotDir = mkdtempSync(join(tmpdir(), "porter-deploy-snap-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(snapshotDir, rel)), { recursive: true });
    writeFileSync(join(snapshotDir, rel), body);
  }
  return { version: 1, createdAt: Date.now(), entrypoint, snapshotDir, ...extra };
}

const fetchText = async (path: string): Promise<string> => (await fetch(`http://127.0.0.1:${appPort}${path}`)).text();

const freeListener = (): void => {
  if (appPort) spawnSync("sh", ["-c", `lsof -ti tcp:${appPort} -sTCP:LISTEN | xargs kill 2>/dev/null; true`]);
};

function make(extra: { terminateLag?: number; resolveCacheMs?: number; visibility?: "public" | "private" } = {}): void {
  fake?.cleanup();
  fake = installFakePorter(extra.terminateLag ? { terminateLag: extra.terminateLag } : {});
  store = createMemoryMap<StoredPorterDeployBody>();
  provider = createPorterDeployProvider({
    appsDomain: "apps.test",
    namePrefix: "qmt",
    appPort,
    readyWindowSec: 10,
    resolveCacheMs: extra.resolveCacheMs ?? 0,
    ...(extra.visibility ? { visibility: extra.visibility } : {}),
    client: fake.client,
    store,
  });
}

beforeEach(async () => {
  freeListener();
  appPort = await freePort();
  make();
});
after(() => {
  fake?.cleanup();
  freeListener();
});

test("apply serves the app on a stable public domain", async () => {
  const d = deployment("dep-1", "myapp");
  const endpoint = await provider.apply(
    d,
    version({ "server.js": SERVER }, "node server.js", { env: { APP_VERSION: "1" } }),
  );
  assert.deepEqual(endpoint, { host: "myapp.apps.test", port: 443, tls: true, publicUrl: "https://myapp.apps.test/" });
  const body = fake.bodies()[0]!;
  assert.equal(body.phase, "running");
  assert.deepEqual(body.networking, [
    { port: appPort, domains: [{ domain: "myapp.apps.test", visibility: "private" }] },
  ]);
  assert.equal(body.tags["qm-deploy"], "dep-1");
  assert.equal(body.env?.APP_VERSION, "1");
  assert.equal(body.env?.PORT, String(appPort));
  assert.equal(body.env?.DATA_DIR, "/data");
  assert.match(await fetchText("/"), /^hello from .*-app v1$/);
  assert.equal(provider.profile.dataDir, "/data");
  assert.equal(provider.profile.managedScaleToZero, false);
});

test("explicit public visibility opts the domain out of the private default", async () => {
  make({ visibility: "public" });
  await provider.apply(deployment("dep-1b", "shown"), version({ "server.js": SERVER }, "node server.js"));
  assert.deepEqual(fake.bodies()[0]!.networking, [
    { port: appPort, domains: [{ domain: "shown.apps.test", visibility: "public" }] },
  ]);
});

test("redeploy keeps the domain and the /data volume and retires the old body", async () => {
  const d = deployment("dep-2", "keeper");
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js", { env: { APP_VERSION: "1" } }));
  writeFileSync(join(fake.volumeDir("qmt-app-dep-2-data"), "note.txt"), "kept");
  const endpoint = await provider.apply(
    d,
    version({ "server.js": SERVER }, "node server.js", { env: { APP_VERSION: "2" } }),
  );
  assert.equal(endpoint.publicUrl, "https://keeper.apps.test/");
  const bodies = fake.bodies();
  assert.equal(bodies.filter((b) => b.phase === "running").length, 1);
  assert.equal(bodies.filter((b) => b.phase === "terminated").length, 1);
  assert.deepEqual(fake.volumeNames(), ["qmt-app-dep-2-data"]);
  assert.match(await fetchText("/"), /v2$/);
  assert.equal(await fetchText("/data"), "kept");
});

test("redeploy waits for a slowly terminating body before claiming its domain", async () => {
  make({ terminateLag: 2 });
  const d = deployment("dep-2b", "slow");
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js", { env: { APP_VERSION: "1" } }));
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js", { env: { APP_VERSION: "2" } }));
  const bodies = fake.bodies();
  assert.equal(bodies.filter((b) => b.phase === "running").length, 1);
  assert.equal(bodies.filter((b) => b.phase === "terminated").length, 1);
  assert.match(await fetchText("/"), /v2$/);
});

test("an entrypoint that hands off to a background child still counts as ready", async () => {
  const d = deployment("dep-2c");
  const endpoint = await provider.apply(
    d,
    version({ "server.js": SERVER }, "(sleep 1; exec node server.js) > /dev/null 2>&1 & exit 0"),
  );
  assert.equal(endpoint.publicUrl, "https://dep-2c.apps.test/");
  assert.match(await fetchText("/"), /^hello from/);
});

test("a failing entrypoint surfaces its output and leaves no body behind", async () => {
  const d = deployment("dep-3");
  await assert.rejects(
    provider.apply(d, version({}, "node -e \"console.error('boom: missing module'); process.exit(3)\"")),
    /exited without binding port[\s\S]*boom: missing module/,
  );
  assert.equal(fake.bodies().filter((b) => b.phase === "running").length, 0);
  assert.equal(await store.get("dep-3"), null);
});

test("logs tails the entrypoint output", async () => {
  const d = deployment("dep-4");
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  const out = await provider.logs!(d, { tailLines: 50 });
  assert.match(out ?? "", /server starting/);
});

test("resolveEndpoint reports the live body and forgets a dead one", async () => {
  const d = deployment("dep-5", "res");
  const v = version({ "server.js": SERVER }, "node server.js");
  const applied = await provider.apply(d, v);
  assert.deepEqual(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), applied);
  fake.terminateAll();
  assert.equal(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), null);
  assert.equal(await store.get("dep-5"), null);
});

test("resolveEndpoint caches the live answer instead of asking Porter on every request", async () => {
  make({ resolveCacheMs: 60_000 });
  const d = deployment("dep-5b", "cached");
  const v = version({ "server.js": SERVER }, "node server.js");
  const applied = await provider.apply(d, v);
  const before = fake.statusReads();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), applied);
  }
  assert.equal(fake.statusReads() - before, 1);
});

test("the endpoint pointer is published only once the app is serving", async () => {
  const d = deployment("dep-5c");
  const seenDuringExec: Array<StoredPorterDeployBody | null> = [];
  const rawExec = fake.client.sandboxes.raw.exec;
  fake.client.sandboxes.raw.exec = async (id, body, options) => {
    seenDuringExec.push(await store.get("dep-5c"));
    return rawExec(id, body, options);
  };
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.ok(seenDuringExec.length > 0);
  assert.ok(seenDuringExec.every((p) => p === null));
  assert.notEqual(await store.get("dep-5c"), null);
});

test("destroy retires the body but keeps the data volume for the next apply", async () => {
  const d = deployment("dep-6");
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  writeFileSync(join(fake.volumeDir("qmt-app-dep-6-data"), "note.txt"), "survives");
  await provider.destroy(d);
  assert.equal(fake.bodies().filter((b) => b.phase === "running").length, 0);
  assert.deepEqual(fake.volumeNames(), ["qmt-app-dep-6-data"]);
  assert.equal(await store.get("dep-6"), null);
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.equal(await fetchText("/data"), "survives");
});

test("a body that vanished between list and terminate does not break destroy or redeploy", async () => {
  const d = deployment("dep-7");
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  const list = fake.client.sandboxes.list;
  fake.client.sandboxes.list = async (options) =>
    (await list(options)).map((sb) => ({
      ...sb,
      get phase() {
        return sb.phase;
      },
      get tags() {
        return sb.tags;
      },
      async terminate() {
        await sb.terminate();
        throw new NotFoundError("sandbox already gone");
      },
    }));
  await provider.destroy(d);
  assert.equal(await store.get("dep-7"), null);
  await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.match(await fetchText("/"), /^hello from/);
});

test("without an apps domain the cluster names the host itself", async () => {
  const bare = createPorterDeployProvider({
    namePrefix: "qmt",
    appPort,
    readyWindowSec: 10,
    client: fake.client,
    store,
  });
  const d = deployment("dep-8");
  const endpoint = await bare.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.deepEqual(fake.bodies().find((b) => b.phase === "running")!.networking, [{ port: appPort }]);
  assert.match(endpoint.host, /^qmt-app-dep-8-[a-z0-9]{5}\.fake\.test$/);
  assert.equal(endpoint.publicUrl, `https://${endpoint.host}/`);
  assert.match(await fetchText("/"), /^hello from/);
});

test("a cluster that names no host fails the deploy and leaves no body behind", async () => {
  fake.cleanup();
  fake = installFakePorter({ assignHost: false });
  const bare = createPorterDeployProvider({
    namePrefix: "qmt",
    appPort,
    readyWindowSec: 10,
    client: fake.client,
    store,
  });
  await assert.rejects(
    bare.apply(deployment("dep-8a"), version({ "server.js": SERVER }, "node server.js")),
    /named no host for the app/,
  );
  assert.equal(fake.bodies().filter((b) => b.phase === "running").length, 0);
});

test("a cluster-assigned hostname wins over the derived domain", async () => {
  const d = deployment("dep-8b", "kept");
  const endpoint = await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.equal(endpoint.host, "kept.apps.test");
  assert.equal(endpoint.publicUrl, `https://${endpoint.host}/`);
  assert.deepEqual(await provider.resolveEndpoint!({ ...d, endpoint }, version({}, "")), endpoint);
  assert.match(await fetchText("/"), /^hello from/);
});

test("deployment names become DNS labels and ids become sandbox-safe names", async () => {
  const d = deployment("dep-9", "My_App.v2");
  const endpoint = await provider.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.match(endpoint.host, /^my-app-v2-[0-9a-f]{6}\.apps\.test$/);
  const body = fake.bodies().find((b) => b.phase === "running")!;
  assert.match(body.name, /^qmt-app-dep-9-/);
  assert.deepEqual(fake.volumeNames(), ["qmt-app-dep-9-data"]);
});
