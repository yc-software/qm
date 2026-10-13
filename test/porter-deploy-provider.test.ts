import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
let reported: { category: string; code: string; message: string; scopeLabel: string }[] = [];
let reportedErrors: unknown[] = [];

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

function make(
  extra: {
    terminateLag?: number;
    resolveCacheMs?: number;
    visibility?: "public" | "private";
    readyWindowSec?: number;
  } = {},
): void {
  fake?.cleanup();
  fake = installFakePorter(extra.terminateLag ? { terminateLag: extra.terminateLag } : {});
  store = createMemoryMap<StoredPorterDeployBody>();
  provider = createPorterDeployProvider({
    appsDomain: "apps.test",
    namePrefix: "qmt",
    appPort,
    readyWindowSec: extra.readyWindowSec ?? 10,
    resolveCacheMs: extra.resolveCacheMs ?? 0,
    ...(extra.visibility ? { visibility: extra.visibility } : {}),
    client: fake.client,
    store,
    onError: (e, error) => {
      reported.push(e);
      reportedErrors.push(error);
    },
  });
}

beforeEach(async () => {
  reported = [];
  reportedErrors = [];
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

const bulkFiles = (): Record<string, string> =>
  Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`assets/file-${i}.txt`, `x${i}`.repeat(50_000)]));

test("apply uploads each tree as one bundle and removes it after unpacking", async () => {
  const execsBefore = fake.execScripts().length;
  await provider.apply(
    deployment("dep-bundle", "bundled"),
    version({ ...bulkFiles(), "server.js": SERVER }, "node server.js", {
      homeDir: mkdtempSync(join(tmpdir(), "porter-deploy-home-")),
    }),
  );
  const scripts = fake.execScripts().slice(execsBefore);
  assert.equal(scripts.filter((s) => s.includes("base64 -d")).length, 0);
  assert.equal(scripts.filter((s) => s.includes("tar -xmf")).length, 1);
  assert.match(await fetchText("/"), /^hello from .*-app v\?$/);
  assert.deepEqual(readdirSync(fake.volumeDir("qmt-app-dep-bundle-data")), []);
});

test("apply writes files one at a time when the bundle upload fails", async () => {
  fake.client.volumes.raw.writeFile = async () => {
    throw new Error("upload refused");
  };
  const execsBefore = fake.execScripts().length;
  await provider.apply(
    deployment("dep-fallback", "fallback"),
    version({ ...bulkFiles(), "server.js": SERVER }, "node server.js"),
  );
  const scripts = fake.execScripts().slice(execsBefore);
  assert.equal(scripts.filter((s) => s.includes("tar -xmf")).length, 0);
  assert.ok(scripts.some((s) => s.includes("base64 -d")));
  assert.match(await fetchText("/"), /^hello from .*-app v\?$/);
});

test("explicit public visibility opts the domain out of the private default", async () => {
  make({ visibility: "public" });
  await provider.apply(deployment("dep-1b", "shown"), version({ "server.js": SERVER }, "node server.js"));
  assert.deepEqual(fake.bodies()[0]!.networking, [
    { port: appPort, domains: [{ domain: "shown.apps.test", visibility: "public" }] },
  ]);
});

test("without an apps domain the app defaults to its cluster-internal address", async () => {
  const bare = createPorterDeployProvider({
    namePrefix: "qmt",
    appPort,
    readyWindowSec: 10,
    client: fake.client,
    store,
  });
  const d = deployment("dep-1c", "hidden");
  const endpoint = await bare.apply(d, version({ "server.js": SERVER }, "node server.js"));
  assert.deepEqual(endpoint, { host: "127.0.0.1", port: appPort });
  assert.deepEqual(fake.bodies()[0]!.networking, [{ port: appPort, internal: true }]);
  assert.equal(fake.bodies()[0]!.host, "");
  assert.deepEqual(await bare.resolveEndpoint!(d, version({}, "true")), endpoint);
  assert.match(await (await fetch(`http://${endpoint.host}:${endpoint.port}/`)).text(), /^hello from .*-app v\?$/);
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

test("an app that crashes after publishing is restarted in place, and keeps resolving while it comes back", async () => {
  const d = deployment("dep-5d", "crashy");
  const crashy = SERVER.replace(
    "if (q.url === '/data')",
    "if (q.url === '/crash') process.exit(1); if (q.url === '/data')",
  );
  const v = version({ "server.js": crashy }, "node server.js");
  const applied = await provider.apply(d, v);
  await fetch(`http://127.0.0.1:${appPort}/crash`).catch(() => {});
  assert.deepEqual(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), applied);
  let body = "";
  for (const end = Date.now() + 10_000; !body && Date.now() < end; await new Promise((r) => setTimeout(r, 200)))
    body = await fetchText("/").catch(() => "");
  assert.match(body, /^hello from/);
  assert.match((await provider.logs!(d, { tailLines: 50 })) ?? "", /entrypoint exited with status 1/);
});

test("resolveEndpoint returns null when the app and its supervisor are both gone, so the service re-applies", async () => {
  const d = deployment("dep-5e", "gone");
  const v = version({ "server.js": SERVER }, "node server.js");
  const applied = await provider.apply(d, v);
  const { sandboxId } = (await store.get("dep-5e"))!;
  await fake.client.sandboxes.raw.exec(sandboxId, { command: ["sh", "-c", 'kill -KILL -"$(cat /tmp/qm-app.pid)"'] });
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100)))
    if (!(await fetchText("/").catch(() => ""))) break;
  assert.equal(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), null);
});

test("an app that only answers 5xx fails publish, and the failure reaches the error log with its redacted output", async () => {
  make({ readyWindowSec: 3 });
  const d = deployment("dep-5f", "broken");
  const server =
    "console.log('connecting to ' + process.env.DATABASE_URL); console.log('booting with api_key=sk-livevalue1234567890'); require('http').createServer((q, s) => { s.statusCode = 500; s.end('boom'); }).listen(process.env.PORT);";
  const env = { DATABASE_URL: "postgres://app:hunter2hunter2@db/app" };
  await assert.rejects(
    provider.apply(d, version({ "server.js": server }, "node server.js", { env })),
    (e: Error) => e === reportedErrors[0] && /HTTP 500[\s\S]*booting/.test(e.message),
  );
  assert.equal(reported.length, 1);
  const [e] = reported;
  assert.equal(e!.code, "app_start_failed");
  assert.equal(e!.scopeLabel, d.ownerScopeId);
  assert.match(e!.message, /app broken \(deployment dep-5f\): app answered HTTP 500[\s\S]*booting/);
  assert.doesNotMatch(e!.message, /sk-livevalue|hunter2/);
  assert.match(e!.message, /connecting to \[redacted\]/);
});

test("a crash the supervisor recovers from is reported once, with the output before the exit", async () => {
  const d = deployment("dep-5g", "crashy2");
  const crashy = SERVER.replace(
    "if (q.url === '/data')",
    "if (q.url === '/crash') { console.error('fatal: out of widgets'); process.exit(3); } if (q.url === '/data')",
  );
  const v = version({ "server.js": crashy }, "node server.js");
  const applied = await provider.apply(d, v);
  await fetch(`http://127.0.0.1:${appPort}/crash`).catch(() => {});
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100)))
    if (/entrypoint exited/.test((await provider.logs!(d, { tailLines: 50 })) ?? "")) break;
  assert.deepEqual(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), applied);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.code, "app_restarted");
  assert.match(reported[0]!.message, /exited 1 time\(s\)[\s\S]*out of widgets[\s\S]*exited with status 3/);
  await provider.resolveEndpoint!({ ...d, endpoint: applied }, v);
  assert.equal(reported.length, 1, "the same crash is not reported twice");
});

test("an app found down with no supervisor is reported with its last output", async () => {
  const d = deployment("dep-5h", "gone2");
  const v = version({ "server.js": SERVER }, "node server.js");
  const applied = await provider.apply(d, v);
  const { sandboxId } = (await store.get("dep-5h"))!;
  await fake.client.sandboxes.raw.exec(sandboxId, { command: ["sh", "-c", 'kill -KILL -"$(cat /tmp/qm-app.pid)"'] });
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100)))
    if (!(await fetchText("/").catch(() => ""))) break;
  assert.equal(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), null);
  assert.equal(await provider.resolveEndpoint!({ ...d, endpoint: applied }, v), null);
  assert.deepEqual(
    reported.map((e) => e.code),
    ["app_down"],
    "the visit path probes twice; one outage is one report",
  );
  assert.match(reported[0]!.message, /server starting/);
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

test("without an apps domain a private app gets the host the cluster names", async () => {
  const bare = createPorterDeployProvider({
    visibility: "private",
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
    visibility: "private",
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
