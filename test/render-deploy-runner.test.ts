import { execFile } from "node:child_process";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { chmod, chown, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { mock, test, type TestContext } from "node:test";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import {
  createRenderDeployArtifacts,
  type StoredRenderDeployCredential,
} from "../src/deploy/render-deploy-artifacts.ts";
import type { DeployGitArchive } from "../src/deploy/deploy-git-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { renderGatewayToken } from "../src/deploy/render-deploy-provider.ts";
import { scopeId } from "../src/types.ts";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Duplex } from "node:stream";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testMap, testDatabaseUrl, testPgPool } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const runner = new URL(process.env.QM_RENDER_RUNNER_MODULE ?? "../deploy/render-runner/start.mjs", import.meta.url);
const sqliteBackupStop = mock.fn(async () => {});
const startSqliteBackup = mock.fn(async (_options: { env: Record<string, string> }) => ({
  exited: new Promise(() => {}),
  assertRunning() {},
  stop: sqliteBackupStop,
}));
mock.module(new URL("./sqlite.mjs", runner).href, { namedExports: { startSqliteBackup } });
const { prepareRenderApp, runRenderApp, createRenderAppGateway } = await import(runner.href);
const signingSecret = "render-runner-secret".repeat(3);

async function fixture(t: TestContext, appSource?: string, entrypoint = "node app.cjs") {
  const root = await mkdtemp(join(tmpdir(), "qm-render-runner-"));
  await chmod(root, 0o755);
  const deployments = testMap<Deployment>();
  const archiveStore = testMap<DeployGitArchive>();
  const credentials = testMap<StoredRenderDeployCredential>();
  const gitDir = join(root, "writer");
  const deployStore = createDeployStore({ deployments, git: { repoRoot: gitDir, archiveStore }, pg: testPgPool() });
  const d = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    snapshotDir: "/unused",
    entrypoint,
    files: [
      {
        path: "app.cjs",
        data:
          appSource ??
          `const result = { version: 1, port: process.env.PORT, secret: process.env.APP_SECRET, git: process.env.GIT_CONFIG_VALUE_0, dataDir: process.env.DATA_DIR, gatewayToken: process.env.QM_RENDER_APP_TOKEN };
const write = () => require("node:fs").writeFileSync("result.json", JSON.stringify(result));
write();
require("node:http").createServer((req,res)=> {
  if (req.url === "/__qa_exit") res.on("finish", () => setImmediate(() => process.exit(23)));
  res.end("ready");
}).listen(Number(process.env.PORT),"127.0.0.1");
const bypass = require("node:net").createServer();
bypass.on("error", error => { result.gatewayPortBlocked = error.code === "EADDRINUSE"; write(); });
bypass.listen(Number(process.env.QM_QA_GATEWAY_PORT), "0.0.0.0");`,
      },
      { path: "old.txt", data: "old version" },
    ],
  });
  let base = "";
  const artifacts = createRenderDeployArtifacts({
    get baseUrl() {
      return base;
    },
    signingSecret,
    store: credentials,
    deployStore,
  });
  const readerStore = createDeployStore({
    deployments,
    git: { repoRoot: join(root, "reader"), archiveStore },
    pg: testPgPool(),
  });
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: readerStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "unused", port: 8080 }),
      destroy: async (deployment) => artifacts.revoke(deployment.id),
    },
    deployDir: join(root, "deploy"),
    acl,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
  });
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const app = createApp({
    deploy,
    deploymentGitPrincipals: artifacts,
    acl,
    identity,
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
  } as unknown as Parameters<typeof createApp>[0]);
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret,
    identity,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, base, d, deployStore, deploy, artifacts, credentials, gitDir, app };
}

async function port() {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function runUntilReadyThenExit(input: {
  manifestPath: string;
  appDir: string;
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
  appPort: number;
}) {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  const running: Promise<number> = runRenderApp(input);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  const readiness = async () => {
    for (;;) {
      signal.throwIfAborted();
      const response = await fetch(`http://127.0.0.1:${input.gatewayPort}/__qm_ready`, {
        headers: { "x-qm-render-app-token": renderGatewayToken(input.env.QM_RENDER_APP_TOKEN!, Date.now() + 60_000) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      }).catch(() => null);
      await response?.body?.cancel();
      if (response?.status === 204) {
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-qm-render-app-ready"), manifest.readinessNonce ?? null);
        return;
      }
      await delay(50, undefined, { signal });
    }
  };
  try {
    await Promise.race([
      readiness(),
      running.then((code) => {
        throw new Error(`Render runner exited before readiness (${code})`);
      }),
    ]);
    const response = await fetch(`http://127.0.0.1:${input.gatewayPort}/__qa_exit`, {
      headers: { "x-qm-render-app-token": renderGatewayToken(input.env.QM_RENDER_APP_TOKEN!, Date.now() + 60_000) },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    return await running;
  } finally {
    controller.abort();
    await fetch(`http://127.0.0.1:${input.appPort}/__qa_exit`, { signal: AbortSignal.timeout(1_000) }).then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
  }
}

async function startApp(
  t: TestContext,
  appSource: string,
  entrypoint?: string,
  options: {
    shutdownGraceMs?: number;
    readinessSweepMs?: number;
    beforeStart?: (manifestPath: string) => Promise<void>;
    manifest?: Record<string, unknown>;
  } = {},
) {
  const { beforeStart, manifest: extra, ...runnerOptions } = options;
  const f = await fixture(t, appSource, entrypoint);
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const manifestPath = join(f.root, "artifact.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      readinessNonce: "n".repeat(43),
      runtimeEnv: { QM_TEST_MANIFEST: manifestPath },
      ...extra,
    }),
  );
  await chmod(manifestPath, 0o600);
  await beforeStart?.(manifestPath);
  const gatewayPort = await port();
  const appPort = await port();
  const running: Promise<number> = runRenderApp({
    manifestPath,
    appDir: join(f.root, "app"),
    gatewayPort,
    appPort,
    env: { ...process.env, QM_RENDER_APP_TOKEN: "a".repeat(43) },
    ...runnerOptions,
  });
  void running.catch(() => {});
  let finished = false;
  void running
    .finally(() => {
      finished = true;
    })
    .catch(() => {});
  t.after(async () => {
    if (!finished) process.emit("SIGTERM", "SIGTERM");
    await running.catch(() => {});
  });
  const request = (path: string) =>
    fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      headers: { "x-qm-render-app-token": renderGatewayToken("a".repeat(43), Date.now() + 60_000) },
      signal: AbortSignal.timeout(5_000),
    });
  await Promise.race([
    running.then((code) => {
      throw new Error(`Runner exited with ${code}`);
    }),
    (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const response = await request("/__qm_ready").catch(() => null);
        await response?.body?.cancel();
        if (response?.status === 204) return;
        await delay(25);
      }
      throw new Error("Runner did not become ready");
    })(),
  ]);
  return { request, running, appPort, appDir: join(f.root, "app") };
}

test(
  "Render runner boots an immutable Git version after core and app cache deletion",
  { timeout: 150_000 },
  async (t) => {
    const f = await fixture(t);
    const v1 = f.d.versions[0]!;
    const manifest = { ...(await f.artifacts.prepare(f.d, v1)), readinessNonce: "n".repeat(43) };
    const manifestPath = join(f.root, "artifact.json");
    const appDir = join(f.root, "app");
    const gatewayPort = await port();
    const appPort = await port();
    await writeFile(manifestPath, JSON.stringify(manifest));
    await chmod(manifestPath, 0o600);
    await f.deployStore.addVersion(f.d.id, {
      snapshotDir: "/unused",
      entrypoint: "node app.cjs",
      files: [{ path: "app.cjs", data: "process.exit(24);" }],
    });
    await rm(f.gitDir, { recursive: true, force: true });
    assert.equal(
      await runUntilReadyThenExit({
        manifestPath,
        appDir,
        gatewayPort,
        appPort,
        env: {
          ...process.env,
          QM_RENDER_APP_TOKEN: "a".repeat(43),
          APP_SECRET: "app-secret",
          GIT_CONFIG_VALUE_0: "parent-token",
          QM_QA_GATEWAY_PORT: String(gatewayPort),
        },
      }),
      23,
    );
    assert.deepEqual(JSON.parse(await readFile(join(appDir, "result.json"), "utf8")), {
      version: 1,
      port: String(appPort),
      secret: "app-secret",
      dataDir: "/data",
      gatewayPortBlocked: true,
    });
    await rm(appDir, { recursive: true });
    await rm(join(f.root, "reader"), { recursive: true });
    assert.equal(
      await runUntilReadyThenExit({
        manifestPath,
        appDir,
        gatewayPort,
        appPort,
        env: { ...process.env, QM_RENDER_APP_TOKEN: "a".repeat(43), QM_QA_GATEWAY_PORT: String(gatewayPort) },
      }),
      23,
    );
    assert.equal(await readFile(join(appDir, "old.txt"), "utf8"), "old version");
    const restarted = createRenderDeployArtifacts({
      baseUrl: f.base,
      signingSecret,
      store: f.credentials,
      deployStore: f.deployStore,
    });
    assert.equal((await restarted.prepare(f.d, v1)).token, manifest.token);
  },
);

test("Render runner credentials deny forgery, cross-app fetches, and Git writes", async (t) => {
  const f = await fixture(t);
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const request = (url: string, token: string, method = "GET") =>
    fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  const refs = `${manifest.url}/info/refs?service=git-upload-pack`;
  assert.equal((await request(refs, manifest.token)).status, 200);
  assert.equal((await request(refs, `${manifest.token}forged`)).status, 401);
  assert.equal((await request(refs.replace(f.d.id, "other-app"), manifest.token)).status, 403);
  assert.equal((await request(`${manifest.url}/git-receive-pack`, manifest.token, "POST")).status, 403);
  const access = await verifyDeployGitAccess(signingSecret, manifest.token, Date.now() + 10 * 365 * 24 * 60 * 60_000);
  assert.equal(access?.permission, "read");
  assert.equal(await f.app.authorizesDeploymentGitAccess(f.d.id, access!.principalId!, "write"), false);
  assert.equal(await f.app.authorizesDeploymentGitAccess(f.d.id, "render-deploy:forged", "read"), false);
});

test("Archiving revokes a runner credential and restoration creates a new one", async (t) => {
  const f = await fixture(t);
  const version = f.d.versions[0]!;
  const manifest = await f.artifacts.prepare(f.d, version);
  await f.deploy.archiveDeployment(f.d.id);
  assert.equal((await f.deployStore.get(f.d.id))!.status, "archived");
  const url = `${manifest.url}/info/refs?service=git-upload-pack`;
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${manifest.token}` } })).status, 403);
  const next = await f.artifacts.prepare((await f.deployStore.get(f.d.id))!, version);
  assert.notEqual(next.token, manifest.token);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${next.token}` } })).status, 200);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${manifest.token}` } })).status, 403);
});

test("Render artifact preparation requires the exact stored version and secure core URL", async (t) => {
  const f = await fixture(t);
  const version = f.d.versions[0]!;
  await assert.rejects(f.artifacts.prepare(f.d, { ...version, commit: "f".repeat(40) }), /matching durable Git commit/);
  await assert.rejects(f.artifacts.prepare(f.d, { ...version, entrypoint: "other" }), /matching durable Git commit/);
  assert.equal(await f.credentials.get(f.d.id), null);
  const insecure = createRenderDeployArtifacts({
    baseUrl: "http://core.example",
    signingSecret,
    store: f.credentials,
    deployStore: f.deployStore,
  });
  await assert.rejects(insecure.prepare(f.d, version), /HTTPS PUBLIC_API_URL/);
});

test("Render runner rejects missing commits and revoked access without executing stale code", async (t) => {
  const f = await fixture(t);
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const file = join(f.root, "manifest.json");
  const dir = join(f.root, "app");
  await writeFile(file, JSON.stringify({ ...manifest, commit: "f".repeat(40) }));
  await assert.rejects(prepareRenderApp(file, dir), /Git command failed \(\d+\): \S/);
  await f.artifacts.revoke(f.d.id);
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(prepareRenderApp(file, dir), /Git command failed \(\d+\): \S/);
});

test("Render runner reports both app startup and backup shutdown failures", async (t) => {
  const f = await fixture(t, "", "exit 7");
  const manifest = await f.artifacts.prepare(f.d, f.d.versions[0]!);
  const manifestPath = join(f.root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, readinessNonce: "n".repeat(43) }), { mode: 0o600 });
  sqliteBackupStop.mock.mockImplementationOnce(async () => {
    throw new Error("backup stop timeout");
  });
  t.after(() => sqliteBackupStop.mock.resetCalls());
  await assert.rejects(
    runRenderApp({
      manifestPath,
      appDir: join(f.root, "app"),
      gatewayPort: await port(),
      appPort: await port(),
      env: { ...process.env, QM_RENDER_APP_TOKEN: "a".repeat(43) },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /app exited before it was ready \(7\).*backup stop timeout/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
});

test("Render runner preserves relative Git symlinks after source staging cleanup", async (t) => {
  const f = await fixture(t);
  const exec = promisify(execFile);
  const checkout = join(f.root, "symlink-source");
  const repo = await f.deployStore.repoUrl(f.d.id);
  await exec("git", ["clone", "--quiet", repo, checkout]);
  await exec("git", ["checkout", "--quiet", "--detach", f.d.versions[0]!.commit!], { cwd: checkout });
  await symlink("old.txt", join(checkout, "linked.txt"));
  await exec("git", ["add", "linked.txt"], { cwd: checkout });
  await exec(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "Add relative link",
    ],
    { cwd: checkout },
  );
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: checkout });
  await exec("git", ["push", "--quiet", "origin", "HEAD:refs/heads/current"], { cwd: checkout });
  const version = await f.deployStore.addVersionFromCommit(f.d.id, stdout.trim());
  assert.ok(version);
  const manifest = await f.artifacts.prepare(f.d, version);
  const file = join(f.root, "symlink-manifest.json");
  const dir = join(f.root, "app");
  await writeFile(file, JSON.stringify(manifest));
  await prepareRenderApp(file, dir);
  assert.equal(await readlink(join(dir, "linked.txt")), "old.txt");
  assert.equal(await readFile(join(dir, "old.txt"), "utf8"), "old version");
  assert.equal(await readFile(join(dir, "linked.txt"), "utf8"), "old version");
});

test("Render private gateway rejects peer requests and removes its credential before forwarding", async (t) => {
  let tokenHeader: unknown;
  let ready = true;
  const application = createHttpServer((req, res) => {
    tokenHeader = req.headers["x-qm-render-app-token"];
    res.end("application");
  });
  await new Promise<void>((resolve) => application.listen(0, "127.0.0.1", resolve));
  const gateway = createRenderAppGateway({
    token: "a".repeat(43),
    readinessNonce: "n".repeat(43),
    isReady: () => ready,
    appPort: (application.address() as AddressInfo).port,
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    gateway.closeAllConnections();
    application.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(resolve)),
      new Promise<void>((resolve) => application.close(() => resolve())),
    ]);
  });
  const url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const valid = renderGatewayToken("a".repeat(43), Date.now() + 60_000);
  const rejected = [
    "other-app",
    "a".repeat(43),
    renderGatewayToken("a".repeat(43), Date.now() - 1),
    renderGatewayToken("b".repeat(43), Date.now() + 60_000),
    `${Date.now() + 60_000}.${valid.split(".")[1]!.slice(1)}`,
  ];
  assert.equal((await fetch(url)).status, 403);
  for (const token of rejected)
    assert.equal((await fetch(url, { headers: { "x-qm-render-app-token": token } })).status, 403);
  const response = await fetch(url, { headers: { "x-qm-render-app-token": valid } });
  assert.equal(await response.text(), "application");
  assert.equal(tokenHeader, undefined);
  for (const token of [undefined, ...rejected, valid]) {
    const response = await fetch(`${url}/__qm_ready`, {
      headers: token ? { "x-qm-render-app-token": token } : {},
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-qm-render-app-ready"), token === valid ? "n".repeat(43) : null);
  }
  ready = false;
  const unavailable = await fetch(`${url}/__qm_ready`, { headers: { "x-qm-render-app-token": valid } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal(unavailable.headers.get("x-qm-render-app-ready"), null);
});

test(
  "Render runner readiness follows the app listener and sends the app no requests",
  { timeout: 45_000 },
  async (t) => {
    const app = await startApp(
      t,
      `const seen = [];
const server = require("node:http").createServer((req, res) => {
  seen.push(req.url);
  if (req.url === "/seen") return res.end(JSON.stringify(seen));
  if (req.url === "/hang") return;
  if (req.url === "/refuse") {
    res.setHeader("Connection", "close");
    server.close();
    setTimeout(() => server.listen(Number(process.env.PORT), "127.0.0.1"), 1_500);
  }
  res.end("ready");
});
server.listen(Number(process.env.PORT), "127.0.0.1");`,
      undefined,
      { readinessSweepMs: 100 },
    );
    await delay(500);
    assert.deepEqual(JSON.parse(await (await app.request("/seen")).text()), ["/seen"]);
    const hanging = app.request("/hang").catch(() => null);
    await delay(500);
    const hung = await app.request("/__qm_ready");
    assert.equal(hung.status, 204);
    assert.equal(hung.headers.get("x-qm-render-app-ready"), "n".repeat(43));
    await (await app.request("/refuse")).text();
    assert.equal((await app.request("/")).status, 502);
    await delay(600);
    const refused = await app.request("/__qm_ready");
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("x-qm-render-app-ready"), null);
    assert.equal((await app.request("/")).status, 503);
    await delay(1_600);
    assert.equal(await (await app.request("/")).text(), "ready");
    const recovered = await app.request("/__qm_ready");
    assert.equal(recovered.status, 204);
    assert.equal(recovered.headers.get("x-qm-render-app-ready"), "n".repeat(43));
    assert.deepEqual(JSON.parse(await (await app.request("/seen")).text()), [
      "/seen",
      "/hang",
      "/refuse",
      "/",
      "/seen",
    ]);
    await hanging;
  },
);

test("Render runner drains responses after the entrypoint shell exits on shutdown", { timeout: 45_000 }, async (t) => {
  const app = await startApp(
    t,
    `const server = require("node:http").createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200);
    res.flushHeaders();
    setTimeout(() => res.end("complete response"), 500);
  } else res.end("ready");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
    "node app.cjs && true",
  );
  const response = await app.request("/slow");
  process.emit("SIGTERM", "SIGTERM");
  assert.equal(await response.text(), "complete response");
  assert.equal(await app.running, 143);
});

test("Render runner waits for descendant cleanup without active requests", { timeout: 45_000 }, async (t) => {
  const app = await startApp(
    t,
    `const server = require("node:http").createServer((_req, res) => res.end("ready"));
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  server.close();
  setTimeout(() => {
    require("node:fs").writeFileSync("cleanup.txt", "complete");
    process.exit(0);
  }, 250);
});`,
    "node app.cjs && true",
  );
  process.emit("SIGTERM", "SIGTERM");
  assert.equal(await app.running, 143);
  assert.equal(await readFile(join(app.appDir, "cleanup.txt"), "utf8"), "complete");
});

test("Render runner gives storage credentials to backups but not to the app", { timeout: 45_000 }, async (t) => {
  startSqliteBackup.mock.resetCalls();
  const storageEnv = { AWS_ACCESS_KEY_ID: "storage-key", AWS_SECRET_ACCESS_KEY: "storage-secret" };
  const app = await startApp(
    t,
    `require("node:http").createServer((_req, res) => res.end(JSON.stringify([process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY ?? null])))
.listen(Number(process.env.PORT), "127.0.0.1");`,
    undefined,
    { manifest: { runtimeEnv: { AWS_ACCESS_KEY_ID: "user-key" }, storageEnv } },
  );
  assert.deepEqual(await (await app.request("/")).json(), ["user-key", null]);
  const backupEnv = startSqliteBackup.mock.calls[0]!.arguments[0].env;
  assert.equal(backupEnv.AWS_ACCESS_KEY_ID, "storage-key");
  assert.equal(backupEnv.AWS_SECRET_ACCESS_KEY, "storage-secret");
});

test(
  "Render runner kills an app that ignores SIGTERM once the shutdown grace period ends",
  { timeout: 45_000 },
  async (t) => {
    const app = await startApp(
      t,
      `const server = require("node:http").createServer((_req, res) => res.end("ready"));
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {});`,
      undefined,
      { shutdownGraceMs: 500 },
    );
    const stopped = Date.now();
    process.emit("SIGTERM", "SIGTERM");
    assert.equal(await app.running, 1);
    assert.ok(Date.now() - stopped < 10_000);
  },
);

test(
  "Render runner starts the app outside group 1000 so a Render secret file stays unreadable",
  { skip: process.getuid?.() === 0 ? false : "switching the app user requires root", timeout: 45_000 },
  async (t) => {
    const app = await startApp(
      t,
      `const fs = require("node:fs");
const server = require("node:http").createServer((req, res) => {
  if (req.url === "/identity") return res.end([process.getuid(), process.getgid(), ...process.getgroups()].join(":"));
  if (req.url === "/manifest") {
    try {
      fs.readFileSync(process.env.QM_TEST_MANIFEST);
      return res.end("readable");
    } catch (error) {
      return res.end(error.code);
    }
  }
  res.end("ready");
});
server.listen(Number(process.env.PORT), "127.0.0.1");`,
      undefined,
      {
        beforeStart: async (manifestPath) => {
          await chown(manifestPath, 0, 1000);
          await chmod(manifestPath, 0o640);
        },
      },
    );
    assert.equal(await (await app.request("/identity")).text(), "10001:10001:10001");
    assert.equal(await (await app.request("/manifest")).text(), "EACCES");
  },
);

test(
  "Render runner refuses to start an app beside a manifest the app user could read",
  { skip: process.getuid?.() === 0 ? false : "switching the app user requires root", timeout: 45_000 },
  async (t) => {
    for (const [mode, uid, gid] of [
      [0o644, 0, 0],
      [0o600, 10001, 0],
      [0o640, 0, 10001],
    ] as const) {
      await assert.rejects(
        startApp(
          t,
          'require("node:http").createServer((_req, res) => res.end("ready")).listen(process.env.PORT);',
          undefined,
          {
            beforeStart: async (manifestPath) => {
              await chown(manifestPath, uid, gid);
              await chmod(manifestPath, mode);
            },
          },
        ),
        /refuses a manifest the app user can read/,
      );
    }
  },
);

async function upgrade(t: TestContext, port: number, token?: string, head = "", until?: string) {
  const socket = connect(port, "127.0.0.1");
  t.after(() => {
    socket.destroy();
  });
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`Upgrade timed out: ${data}`));
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (until && data.includes(until)) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("connect", () =>
      socket.write(
        `GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${token ? `x-qm-render-app-token: ${token}\r\n` : ""}\r\n${head}`,
      ),
    );
  });
}

test("Render gateway forwards WebSocket upgrades, both head buffers, and HTTP rejections", async (t) => {
  let reject = false;
  let forwardedToken: unknown;
  const application = createHttpServer();
  application.on("upgrade", (req, socket, head) => {
    t.after(() => {
      socket.destroy();
    });
    forwardedToken = req.headers["x-qm-render-app-token"];
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    if (reject) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nWWW-Authenticate: Bearer\r\nConnection: close\r\n\r\ndenied",
      );
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-head");
    if (head.length) socket.write(`echo:${head}`);
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
  });
  await new Promise<void>((resolve) => application.listen(0, "127.0.0.1", resolve));
  let ready = true;
  const gateway = createRenderAppGateway({
    token: "a".repeat(43),
    appPort: (application.address() as AddressInfo).port,
    isReady: () => ready,
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    gateway.close();
    application.close();
  });
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const valid = renderGatewayToken("a".repeat(43), Date.now() + 60_000);
  assert.match(await upgrade(t, gatewayPort), /^HTTP\/1.1 403 /);
  assert.match(await upgrade(t, gatewayPort, "a".repeat(43)), /^HTTP\/1.1 403 /);
  ready = false;
  assert.match(await upgrade(t, gatewayPort, valid), /^HTTP\/1.1 503 /);
  ready = true;
  const switched = await upgrade(t, gatewayPort, valid, "client-head", "echo:client-head");
  assert.match(switched, /^HTTP\/1.1 101 /);
  assert.ok(switched.includes("server-head"));
  assert.equal(forwardedToken, undefined);
  reject = true;
  const denied = await upgrade(t, gatewayPort, valid);
  assert.match(denied, /^HTTP\/1.1 401 /);
  assert.match(denied, /www-authenticate: Bearer/i);
  assert.ok(denied.endsWith("denied"));
  await new Promise<void>((resolve) => application.close(() => resolve()));
  assert.match(await upgrade(t, gatewayPort, valid), /^HTTP\/1.1 502 /);
});

test("Render gateway keeps proxying after clients disconnect mid-request", { timeout: 15_000 }, async (t) => {
  for (const kind of ["request body", "response", "WebSocket"] as const) {
    await t.test(kind, async (t) => {
      const started = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const application = createHttpServer((req, res) => {
        if (req.url === "/abort") {
          req.socket.on("close", () => closed.resolve());
          started.resolve();
        } else res.end("ready");
      });
      application.on("upgrade", (_req, socket) => {
        t.after(() => {
          socket.destroy();
        });
        socket.on("error", () => socket.destroy());
        socket.on("end", () => socket.destroy());
        socket.on("close", () => closed.resolve());
        started.resolve();
      });
      await new Promise<void>((resolve) => application.listen(0, "127.0.0.1", resolve));
      const gateway = createRenderAppGateway({
        token: "a".repeat(43),
        appPort: (application.address() as AddressInfo).port,
      });
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      t.after(() => {
        gateway.closeAllConnections();
        gateway.close();
        application.closeAllConnections();
        application.close();
      });
      const gatewayPort = (gateway.address() as AddressInfo).port;
      const client = connect(gatewayPort, "127.0.0.1");
      t.after(() => {
        client.destroy();
      });
      client.on("connect", () => {
        const body = kind === "request body";
        const headers = {
          "request body": "Content-Length: 10\r\n",
          response: "",
          WebSocket: "Connection: Upgrade\r\nUpgrade: websocket\r\n",
        }[kind];
        client.write(
          `${body ? "POST" : "GET"} /abort HTTP/1.1\r\nHost: localhost\r\nx-qm-render-app-token: ${renderGatewayToken("a".repeat(43), Date.now() + 60_000)}\r\n${headers}\r\n${body ? "x" : ""}`,
        );
      });
      await started.promise;
      client.destroy();
      await closed.promise;
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
        headers: { "x-qm-render-app-token": renderGatewayToken("a".repeat(43), Date.now() + 60_000) },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ready");
    });
  }
});

test("Render gateway flushes WebSocket close frames to a slow client", { timeout: 5_000 }, async (t) => {
  const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xe8]);
  const application = createHttpServer();
  application.on("upgrade", (_req, socket) => {
    t.after(() => {
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.end(
      Buffer.concat([
        Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"),
        closeFrame,
      ]),
    );
  });
  await new Promise<void>((resolve) => application.listen(0, "127.0.0.1", resolve));
  const gateway = createRenderAppGateway({
    token: "a".repeat(43),
    appPort: (application.address() as AddressInfo).port,
  });
  t.after(() => {
    gateway.close();
    application.close();
  });
  const received: Buffer[] = [];
  const client = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      setTimeout(() => {
        if (!client.destroyed) received.push(Buffer.from(chunk));
        done();
      }, 50);
    },
  });
  t.after(() => {
    client.destroy();
  });
  const finished = new Promise<void>((resolve) => {
    client.once("finish", resolve);
    client.once("close", resolve);
  });
  gateway.emit(
    "upgrade",
    {
      headers: {
        "x-qm-render-app-token": renderGatewayToken("a".repeat(43), Date.now() + 60_000),
        connection: "Upgrade",
        upgrade: "websocket",
      },
      method: "GET",
      url: "/socket",
    },
    client,
    Buffer.alloc(0),
  );
  await finished;
  const response = Buffer.concat(received);
  assert.match(response.toString(), /^HTTP\/1.1 101 /);
  assert.deepEqual(response.subarray(-closeFrame.length), closeFrame);
});
