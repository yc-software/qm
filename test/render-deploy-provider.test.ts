import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRenderDeployProvider,
  type RenderDeployProviderOptions,
  type StoredRenderDeploy,
} from "../src/deploy/render-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { fakeDeployment } from "./support/fake-render.ts";
import { testMap } from "./support/test-database.ts";

const sha = "a".repeat(40);
const readyProbes = 40;
const writePaths = {
  environment: "/environments",
  create: "/services",
  resume: "/services/srv-app/resume",
  deploy: "/services/srv-app/deploys",
};

function fixture(appRegion?: string) {
  const store = testMap<StoredRenderDeploy>();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let service: any = null;
  let environment: any = null;
  const deploys: any[] = [];
  const logs: Array<{ timestamp: string; message: string }> = [];
  let outcome = "live";
  let builtCommit: string | undefined;
  let foreignDeployOnEnvWrite: string | undefined;
  let foreignDeployAfterSnapshot: string | undefined;
  let rejectCancel = false;
  let loseCreate = false;
  let loseUpdate = false;
  let failure:
    { method: string; path: string; status?: number; times: number; headers?: Record<string, string> } | undefined;
  let heldRead: { reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  let activeEnv: any[] = [];
  let manifestNonce: string | undefined;
  let readinessNonce: string | null | undefined;
  let readinessResponse = (response: Response): Response | Promise<Response> => response;
  const data = new Map<string, string>();
  let branchTip = sha;
  let resumeOutcome: string | undefined;
  let loseResume = false;
  let refuseResume = false;
  let resumeRace = false;
  let manifest: any;
  const credentialCalls: string[] = [];
  let savedRegionBeforeCreate: string | undefined;
  const artifacts = {
    prepare: async (d: Deployment, v: Deployment["versions"][number]) => {
      credentialCalls.push("prepare");
      return {
        url: `https://core.example/v1/deployments/${d.id}/git`,
        token: "source-token",
        commit: v.commit ?? sha,
        entrypoint: v.entrypoint,
      };
    },
    revoke: async () => {
      credentialCalls.push("revoke");
    },
    authorizes: async () => false,
  };
  const response = (value: unknown, status = 200) =>
    new Response(value === undefined ? null : JSON.stringify(value), { status });
  const options: RenderDeployProviderOptions = {
    apiKey: "key",
    workspaceId: "tea-test",
    projectId: "prj-test",
    environmentId: "env-test",
    appRegion,
    source: { repo: "https://github.com/test/qm", branch: "release", commit: sha },
    store,
    artifacts,
    resources: {
      ensure: async (_id: string, repair?: boolean) => {
        credentialCalls.push(repair ? "repair" : "ensure");
        return { S3_PREFIX: "app-data/scoped/" };
      },
    },
    pollIntervalMs: 1,
    deployTimeoutMs: 1000,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = `${url.pathname}${url.search}`.replace(/^\/v1/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (heldRead && method === "GET" && path === "/services/srv-app") {
        const held = heldRead;
        heldRead = undefined;
        held.reached.resolve();
        await held.release.promise;
      }
      if (failure?.method === method && path.startsWith(failure.path)) {
        const { status, headers } = failure;
        if (--failure.times <= 0) failure = undefined;
        if (status) return new Response(null, { status, ...(headers ? { headers } : {}) });
        throw new TypeError("connection lost before write");
      }
      if (url.hostname === "qm-private") {
        const token = new Headers(init?.headers).get("x-qm-render-app-token");
        const raw = (await store.get(deployment.id))!.token;
        if (token === raw) return new Response(null, { status: 403 });
        const nonce = readinessNonce === undefined ? manifestNonce : readinessNonce;
        return readinessResponse(
          new Response(null, { status: 204, headers: nonce ? { "x-qm-render-app-ready": nonce } : {} }),
        );
      }
      if (path === "/environments/env-test") return response({ id: "env-test", projectId: "prj-test" });
      if (path.startsWith("/logs?")) return response({ logs });
      if (path === "/projects/prj-test") return response({ owner: { id: "tea-test" } });
      if (path.startsWith("/environments?")) return response(environment ? [{ environment }] : []);
      if (path === "/environments" && method === "POST") {
        savedRegionBeforeCreate = (await store.get(deployment.id))?.appRegion;
        environment = { ...body, id: "env-app" };
        return response(environment);
      }
      if (path === "/environments/env-app") return response(environment);
      if (path.startsWith("/services?") && method === "GET") return response(service ? [{ service }] : []);
      if (path === "/services" && method === "POST") {
        activeEnv = body.envVars;
        service = {
          id: "srv-app",
          ...body,
          suspended: "not_suspended",
          serviceDetails: { ...body.serviceDetails, url: "https://qm-private" },
        };
        const deploy = { id: `dep-${deploys.length}`, status: "update_failed", commit: { id: "b".repeat(40) } };
        deploys.unshift(deploy);
        if (loseCreate) {
          loseCreate = false;
          throw new TypeError("connection lost");
        }
        return response({ service, deployId: deploy.id });
      }
      if (path === "/services/srv-app" && method === "GET") return service ? response(service) : response({}, 404);
      if (path === "/services/srv-app" && method === "PATCH") {
        service = { ...service, ...body, serviceDetails: { ...service.serviceDetails, ...body.serviceDetails } };
        return response(service);
      }
      if (path === "/services/srv-app/env-vars/QM_DEPLOYMENT_ID")
        return response({ value: activeEnv.find((row) => row.key === "QM_DEPLOYMENT_ID")?.value });
      if (path === "/services/srv-app/env-vars" && method === "PUT") {
        activeEnv = body;
        if (foreignDeployOnEnvWrite)
          deploys.unshift({ id: `dep-${deploys.length}`, status: "live", commit: { id: foreignDeployOnEnvWrite } });
        return response(body);
      }
      if (path === "/services/srv-app/secret-files" && method === "PUT") {
        manifest = body.length ? JSON.parse(body[0].content) : undefined;
        manifestNonce = manifest?.readinessNonce;
        return response(body);
      }
      if (path.startsWith("/services/srv-app/deploys?") && method === "GET") {
        const pending = (await store.get(deployment.id))?.pending;
        if (foreignDeployAfterSnapshot && pending && !pending.deployId) {
          deploys.unshift({ id: `dep-${deploys.length}`, status: "live", commit: { id: foreignDeployAfterSnapshot } });
          foreignDeployAfterSnapshot = undefined;
        }
        return response(deploys.map((deploy) => ({ deploy })));
      }
      if (path.endsWith("/cancel") && method === "POST") {
        const deploy = deploys.find((item) => path.includes(`/${item.id}/`))!;
        deploy.status = rejectCancel ? "live" : "canceled";
        return rejectCancel ? response({ message: "deploy is not in progress" }, 400) : response(deploy);
      }
      if (path.startsWith("/services/srv-app/deploys/"))
        return response(deploys.find((deploy) => path.endsWith(deploy.id)));
      if (path === "/services/srv-app/deploys" && method === "POST") {
        if (service.suspended === "suspended") return response({ message: "cannot deploy suspended service" }, 400);
        const deploymentId = activeEnv.find((row) => row.key === "QM_DEPLOYMENT_ID").value;
        assert.equal((await store.get(deploymentId))?.pending?.readinessNonce, manifestNonce);
        const deploy = { id: `dep-${deploys.length}`, status: outcome, commit: { id: builtCommit ?? body.commitId } };
        for (const previous of deploys)
          if (previous.status === "live" && outcome === "live") previous.status = "deactivated";
        deploys.unshift(deploy);
        if (loseUpdate) {
          loseUpdate = false;
          throw new TypeError("connection lost");
        }
        return response(deploy);
      }
      if (path === "/services/srv-app/suspend") {
        service.suspended = "suspended";
        return response({});
      }
      if (path === "/services/srv-app/resume") {
        if (refuseResume || service.suspended !== "suspended")
          return response({ message: "only services suspended by a user can be resumed" }, 400);
        service.suspended = "not_suspended";
        const status = resumeOutcome ?? outcome;
        for (const previous of deploys)
          if (previous.status === "live" && status === "live") previous.status = "deactivated";
        deploys.unshift({ id: `dep-${deploys.length}`, status, commit: { id: branchTip } });
        if (loseResume) {
          loseResume = false;
          throw new TypeError("connection lost");
        }
        if (resumeRace) {
          resumeRace = false;
          return response({ message: "only services suspended by a user can be resumed" }, 400);
        }
        return response({});
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const provider = createRenderDeployProvider(options);
  const deployment = fakeDeployment([
    { version: 1, createdAt: 1, entrypoint: "node app.js", snapshotDir: "/unused", commit: sha },
  ]);
  return {
    store,
    calls,
    provider,
    logs,
    data,
    deployment,
    failNextRequest(method: string, path: string, status?: number, times = 1, headers?: Record<string, string>) {
      failure = { method, path, status, times, ...(headers ? { headers } : {}) };
    },
    holdServiceRead() {
      heldRead = { reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      return { reached: heldRead.reached.promise, release: heldRead.release.resolve };
    },
    credentialCalls,
    get manifest() {
      return manifest;
    },
    set branchTip(value: string) {
      branchTip = value;
    },
    set resumeOutcome(value: string | undefined) {
      resumeOutcome = value;
    },
    set loseResume(value: boolean) {
      loseResume = value;
    },
    set refuseResume(value: boolean) {
      refuseResume = value;
    },
    set resumeRace(value: boolean) {
      resumeRace = value;
    },
    get savedRegionBeforeCreate() {
      return savedRegionBeforeCreate;
    },
    get manifestNonce() {
      return manifestNonce;
    },
    set readinessNonce(value: string | null | undefined) {
      readinessNonce = value;
    },
    set readinessResponse(value: typeof readinessResponse) {
      readinessResponse = value;
    },
    set outcome(value: string) {
      outcome = value;
    },
    set builtCommit(value: string | undefined) {
      builtCommit = value;
    },
    set foreignDeployOnEnvWrite(value: string | undefined) {
      foreignDeployOnEnvWrite = value;
    },
    set foreignDeployAfterSnapshot(value: string | undefined) {
      foreignDeployAfterSnapshot = value;
    },
    set rejectCancel(value: boolean) {
      rejectCancel = value;
    },
    startDeploy(status: string, commit: string) {
      deploys.unshift({ id: `dep-${deploys.length}`, status, commit: { id: commit } });
    },
    set loseCreate(value: boolean) {
      loseCreate = value;
    },
    set loseUpdate(value: boolean) {
      loseUpdate = value;
    },
    get service() {
      return service;
    },
    get environment() {
      return environment;
    },
    deleteService() {
      service = null;
    },
    restart(commit: string, nextAppRegion = options.appRegion) {
      return createRenderDeployProvider({
        ...options,
        appRegion: nextAppRegion,
        source: { ...options.source, commit },
      });
    },
    finishPending() {
      deploys[0].status = "live";
    },
  };
}

test("Render retains the app region through pending recovery and update after a default change", async () => {
  const f = fixture("virginia");
  const d = f.deployment;
  const v1 = d.versions[0]!;
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(d, v1), /unconfirmed deployment/);
  assert.equal(f.savedRegionBeforeCreate, "virginia");
  assert.equal(f.service.serviceDetails.region, "virginia");
  f.finishPending();
  f.outcome = "live";
  const restarted = f.restart(sha, "ohio");
  const endpoint = await restarted.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  assert.deepEqual(await restarted.apply(d, { ...v1, version: 2 }), endpoint);
  d.appliedVersion = 2;
  await restarted.destroy(d);
  assert.deepEqual(await restarted.apply(d, v1), endpoint);
  assert.equal((await f.store.get(d.id))!.appRegion, "virginia");
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
  f.service.serviceDetails.region = "ohio";
  await assert.rejects(restarted.apply(d, { ...v1, version: 2 }), /expected gated service with a persistent disk/);
});

test("Render app logs use nanosecond time order and retain entries with the same timestamp", async () => {
  const f = fixture();
  await f.provider.apply(f.deployment, f.deployment.versions[0]!);
  f.logs.push(
    { timestamp: "2026-10-18T12:00:00.1001Z", message: "ready" },
    { timestamp: "2026-10-18T12:00:00.100Z", message: "starting" },
    { timestamp: "2026-10-18T12:00:00.100000000Z", message: "same time" },
    { timestamp: "2026-10-18T12:00:00Z", message: "created" },
  );
  assert.equal(await f.provider.logs!(f.deployment, { tailLines: 4 }), "created\nstarting\nsame time\nready");
});

test("Render app create, update, rollback, and archive retain one service with a persistent disk and scoped data", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  d.endpoint = endpoint;
  f.data.set("retained", "value");
  const v2 = { ...v1, version: 2, commit: "b".repeat(40) };
  const updated = await f.provider.apply(d, v2);
  d.appliedVersion = 2;
  assert.deepEqual(updated, endpoint);
  const updatedNonce = f.manifestNonce;
  await f.provider.apply(d, v1);
  assert.notEqual(f.manifestNonce, updatedNonce);
  assert.equal(f.data.get("retained"), "value");
  await f.provider.destroy(d);
  assert.equal(f.credentialCalls.at(-1), "revoke");
  assert.equal(await f.provider.resolveEndpoint!(d, v1), null);
  d.status = "archived";
  const restored = await f.provider.apply(d, v1);
  assert.deepEqual(restored, endpoint);
  assert.equal(f.data.get("retained"), "value");
  assert.equal(f.credentialCalls.at(-1), "prepare");
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services").length, 1);
  const created = f.calls.find((c) => c.method === "POST" && c.path === "/services")!.body;
  assert.equal(created.environmentId, "env-app");
  assert.equal(f.environment.networkIsolationEnabled, true);
  assert.equal(f.environment.projectId, "prj-test");
  assert.deepEqual(created.envVars, [{ key: "QM_DEPLOYMENT_ID", value: d.id }]);
  assert.deepEqual(created.secretFiles, []);
  assert.equal(created.serviceDetails.envSpecificDetails.dockerCommand, "/bin/sh -c exit 0");
  assert.equal(created.repo, "https://github.com/test/qm");
  assert.deepEqual(created.serviceDetails.disk, { name: "data", mountPath: "/data", sizeGB: 1 });
  assert.equal(created.serviceDetails.maxShutdownDelaySeconds, undefined);
  assert.equal(f.provider.profile.dataDir, "/data");
  assert.equal(created.serviceDetails.runtime, "docker");
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
  assert.ok(
    f.calls
      .filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys")
      .every((c) => c.body.commitId === sha),
  );
});

test("Render gives app storage credentials only to the runner, not the app environment", async () => {
  const f = fixture();
  const v1 = f.deployment.versions[0]!;
  await f.provider.apply(f.deployment, { ...v1, env: { AWS_ACCESS_KEY_ID: "user-key", S3_PREFIX: "user/" } });
  assert.deepEqual(f.manifest.runtimeEnv, { AWS_ACCESS_KEY_ID: "user-key", S3_PREFIX: "user/" });
  assert.deepEqual(f.manifest.storageEnv, { S3_PREFIX: "app-data/scoped/" });
});

for (const commit of ["f".repeat(40), sha])
  test(`Render submits its own deploy when a deploy of ${commit === sha ? "the same" : "another"} commit starts during an update`, async () => {
    const f = fixture();
    const d = f.deployment;
    const v1 = d.versions[0]!;
    await f.provider.apply(d, v1);
    f.foreignDeployOnEnvWrite = commit;
    await f.provider.apply(d, { ...v1, version: 2 });
    const submitted = f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys");
    assert.equal(submitted.length, 2);
    assert.ok(submitted.every((c) => c.body.commitId === sha));
    const record = (await f.store.get(d.id))!;
    assert.equal(record.liveVersion, 2);
    assert.equal(record.pending, undefined);
  });

test("Render submits its own deploy when another commit goes live after its submission is recorded", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.foreignDeployAfterSnapshot = "f".repeat(40);
  await f.provider.apply(d, { ...v1, version: 2 });
  const record = (await f.store.get(d.id))!;
  assert.equal(record.liveVersion, 2);
  assert.equal(record.pending, undefined);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys").length, 2);
});

test("Render continues when a deploy finishes before its cancellation is accepted", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.startDeploy("build_in_progress", "f".repeat(40));
  f.rejectCancel = true;
  await f.provider.apply(d, { ...v1, version: 2 });
  assert.equal((await f.store.get(d.id))!.liveVersion, 2);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/cancel")).length, 1);
  f.startDeploy("build_in_progress", "f".repeat(40));
  f.rejectCancel = false;
  await f.provider.apply(d, v1);
  assert.equal((await f.store.get(d.id))!.liveVersion, 1);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/cancel")).length, 2);
});

test("Render clears a pending deploy built from another commit so a retry deploys again", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.builtCommit = "f".repeat(40);
  await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /different Git commit/);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
  f.builtCommit = undefined;
  await f.provider.apply(d, { ...v1, version: 2 });
  assert.equal((await f.store.get(d.id))!.liveVersion, 2);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys").length, 3);
});

test("Render recovers create and update replies without a duplicate service or deployment", async () => {
  const f = fixture();
  f.loseCreate = true;
  await f.provider.apply(f.deployment, f.deployment.versions[0]!);
  f.loseUpdate = true;
  await f.provider.apply(f.deployment, { ...f.deployment.versions[0]!, version: 2 });
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.path === "/services/srv-app/deploys").length, 2);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, 2);
});

for (const status of [undefined, 503]) {
  for (const operation of ["environment", "create", "resume", "deploy"] as const) {
    test(`Render retries ${operation} after ${status ?? "connection loss"} before the write and can archive`, async () => {
      const f = fixture();
      const d = f.deployment;
      const v1 = d.versions[0]!;
      const path = writePaths[operation];
      if (operation === "deploy" || operation === "resume") {
        d.endpoint = await f.provider.apply(d, v1);
        d.status = "running";
        d.appliedVersion = 1;
        if (operation === "resume") await f.provider.destroy(d);
      }
      const version = operation === "deploy" ? { ...v1, version: 2 } : v1;
      const posts = () => f.calls.filter((call) => call.method === "POST" && call.path === path);
      const before = posts().length;
      f.data.set("retained", "value");
      f.failNextRequest("POST", path, status);
      await assert.rejects(f.provider.apply(d, version), /503|connection lost|bootstrap is unconfirmed/);
      assert.equal(posts().length, before + 1);
      const restarted = f.restart(operation === "deploy" ? "c".repeat(40) : sha);
      await restarted.apply(d, version);
      assert.equal(posts().length, before + 2);
      if (operation === "deploy") assert.equal(posts().at(-1)!.body.commitId, sha);
      await restarted.destroy(d);
      assert.equal(posts().length, before + 2);
      assert.equal(f.credentialCalls.at(-1), "revoke");
      const record = (await f.store.get(d.id))!;
      assert.equal(record.suspended, true);
      assert.equal(record.pending, undefined);
      assert.equal(f.data.get("retained"), "value");
    });
  }
}

for (const outcome of ["not_submitted", "build_in_progress", "old_instance"]) {
  test(`Render can archive and restore when a deployment is ${outcome}`, async () => {
    const f = fixture();
    const d = f.deployment;
    const v1 = d.versions[0]!;
    d.endpoint = await f.provider.apply(d, v1);
    d.status = "running";
    d.appliedVersion = 1;
    if (outcome === "not_submitted") f.failNextRequest("POST", "/services/srv-app/deploys");
    else if (outcome === "build_in_progress") f.outcome = outcome;
    else f.readinessNonce = f.manifestNonce;
    await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost|unconfirmed/);
    const pending = (await f.store.get(d.id))!.pending;
    assert.ok(pending);
    const before = f.calls.length;
    const restarted = f.restart(sha);
    await restarted.destroy(d);
    assert.equal(f.credentialCalls.at(-1), "revoke");
    assert.equal((await f.store.get(d.id))!.pending, undefined);
    assert.equal((await f.store.get(d.id))!.suspended, true);
    assert.equal(
      f.calls.slice(before).some((call) => call.path.includes("/deploys")),
      false,
    );
    f.finishPending();
    f.outcome = "live";
    f.readinessNonce = undefined;
    await restarted.apply(d, v1);
    assert.equal(f.credentialCalls.at(-1), "prepare");
    assert.equal((await f.store.get(d.id))!.suspended, false);
  });
}

test("Render polls only the deploy while it waits for a deployment and reads one deploy while it idles", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(d, v1), /unconfirmed deployment/);
  const submitted = f.calls.findIndex((call) => call.method === "POST" && call.path === "/services/srv-app/deploys");
  const polled = f.calls.slice(submitted + 1).map((call) => `${call.method} ${call.path}`);
  assert.ok(polled.length >= 2);
  assert.match(polled[0]!, /^GET \/services\/srv-app\/deploys\/dep-\d+$/);
  assert.deepEqual(new Set(polled), new Set([polled[0]]));
  f.outcome = "live";
  const mark = f.calls.length;
  await f.provider.apply(d, { ...v1, version: 2 });
  const canceled = f.calls.findIndex((call, index) => index >= mark && call.path.endsWith("/cancel"));
  assert.ok(canceled > mark);
  assert.deepEqual(
    f.calls.slice(canceled + 1, canceled + 2).map((call) => `${call.method} ${call.path}`),
    ["GET /services/srv-app/deploys?limit=1"],
  );
});

test("Render keeps the failure as the cause of unconfirmed bootstraps and deployments", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  f.failNextRequest("POST", "/services");
  await assert.rejects(f.provider.apply(d, v1), (error: Error) => {
    assert.match(error.message, /bootstrap is unconfirmed/);
    assert.match((error.cause as Error).message, /connection lost/);
    return true;
  });
  await f.provider.apply(d, v1);
  f.failNextRequest("GET", "/__qm_ready", undefined, Number.POSITIVE_INFINITY);
  await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), (error: Error) => {
    assert.match(error.message, /unconfirmed deployment/);
    assert.match((error.cause as Error).message, /connection lost/);
    return true;
  });
});

test("Render retains pending state when archive cannot confirm suspension", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  await f.provider.apply(d, v1);
  f.failNextRequest("POST", "/services/srv-app/deploys");
  await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost/);
  const pending = (await f.store.get(d.id))!.pending;
  f.failNextRequest("POST", "/services/srv-app/suspend", 503);
  await assert.rejects(f.provider.destroy(d), /503/);
  assert.deepEqual((await f.store.get(d.id))!.pending, pending);
  assert.equal((await f.store.get(d.id))!.suspended, false);
  assert.equal(f.credentialCalls.includes("revoke"), false);
  await f.restart(sha).destroy(d);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
});

for (const status of [undefined, 200])
  test(`Render does not submit again after a ${status ?? "failed"} reconciliation response`, async () => {
    for (const operation of ["environment", "create", "deploy"] as const) {
      const f = fixture();
      const d = f.deployment;
      const v1 = d.versions[0]!;
      if (operation === "deploy") await f.provider.apply(d, v1);
      const path = writePaths[operation];
      f.failNextRequest("POST", path);
      await assert.rejects(f.provider.apply(d, { ...v1, version: 2 }), /connection lost|bootstrap is unconfirmed/);
      const posts = f.calls.filter((call) => call.method === "POST").length;
      f.failNextRequest("GET", `${path}?`, status, Number.POSITIVE_INFINITY);
      await assert.rejects(f.restart(sha).apply(d, { ...v1, version: 2 }), /connection lost|invalid .* list/);
      assert.equal(f.calls.filter((call) => call.method === "POST").length, posts);
    }
  });

test("Render deploy API retries reads on 5xx, retries submissions only on 429, and reports the request id", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const count = (method: string, path: string) =>
    f.calls.filter((call) => call.method === method && call.path === path).length;
  f.failNextRequest("POST", "/services", 429, 1, { "retry-after": "0" });
  await f.provider.apply(d, v1);
  assert.equal(count("POST", "/services"), 2);
  const environment = count("GET", "/environments/env-test");
  f.failNextRequest("GET", "/environments/env-test", 503, 1, { "retry-after": "0" });
  await f.provider.apply(d, { ...v1, version: 2 });
  assert.equal(count("GET", "/environments/env-test"), environment + 2);
  const deploys = count("POST", "/services/srv-app/deploys");
  f.failNextRequest("POST", "/services/srv-app/deploys", 503, 1, { "render-request-id": "req-submit" });
  await assert.rejects(
    f.provider.apply(d, { ...v1, version: 3 }),
    /POST \/services\/srv-app\/deploys: http 503\s+\[request id req-submit\]/,
  );
  assert.equal(count("POST", "/services/srv-app/deploys"), deploys + 1);
  const reads = count("GET", "/environments/env-test");
  f.failNextRequest("GET", "/environments/env-test", 500, Number.POSITIVE_INFINITY, {
    "retry-after": "0",
    "render-request-id": "req-read",
  });
  await assert.rejects(f.restart(sha).apply(d, { ...v1, version: 3 }), /http 500\s+\[request id req-read\]/);
  assert.equal(count("GET", "/environments/env-test"), reads + 4);
});

test("A failed Render update keeps the live endpoint and does not suspend retained resources", async () => {
  const f = fixture();
  const d = f.deployment;
  const first = await f.provider.apply(d, d.versions[0]!);
  d.appliedVersion = 1;
  d.status = "running";
  f.outcome = "build_failed";
  await assert.rejects(f.provider.apply(d, { ...d.versions[0]!, version: 2 }), /build_failed/);
  assert.deepEqual(await f.provider.resolveEndpoint!(d, d.versions[0]!), first);
  assert.equal(f.credentialCalls.includes("revoke"), false);
  assert.equal((await f.store.get(d.id))!.liveVersion, 1);
  assert.equal(
    f.calls.some((c) => c.path.endsWith("/suspend")),
    false,
  );
});

test("Render resolves a live endpoint with one cached service check and keeps it through Render API outages", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const live = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  const mark = f.calls.length;
  const resolved = await Promise.all([0, 1, 2].map(() => f.provider.resolveEndpoint!(d, v1)));
  for (const endpoint of resolved) assert.deepEqual(endpoint, live);
  assert.deepEqual(
    f.calls.slice(mark).map((call) => `${call.method} ${call.path}`),
    ["GET /services/srv-app"],
  );
  f.failNextRequest("GET", "/services/srv-app", 503, 4, { "retry-after": "0" });
  assert.deepEqual(await f.restart(sha).resolveEndpoint!(d, v1), live);
  f.failNextRequest("GET", "/services/srv-app", 404);
  assert.deepEqual(await f.restart(sha).resolveEndpoint!(d, v1), live);
  f.deleteService();
  assert.equal(await f.restart(sha).resolveEndpoint!(d, v1), null);
});

test("Render resolves the endpoint of a live record without a saved host and saves the host", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const live = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  await f.store.merge(d.id, { host: undefined });
  const mark = f.calls.length;
  assert.deepEqual(await f.restart(sha).resolveEndpoint!(d, v1), live);
  assert.equal((await f.store.get(d.id))!.host, live.host);
  assert.equal(
    f.calls.slice(mark).some((call) => call.method !== "GET"),
    false,
  );
});

test("Render keeps waiting endpoint requests while an apply or an archive starts", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const live = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  for (const operation of ["apply", "destroy"] as const) {
    const provider = f.restart(sha);
    const held = f.holdServiceRead();
    const waiting = [provider.resolveEndpoint!(d, v1), provider.resolveEndpoint!(d, v1)];
    await held.reached;
    const running = operation === "apply" ? provider.apply(d, { ...v1, version: 2 }) : provider.destroy(d);
    held.release();
    for (const endpoint of await Promise.all(waiting)) assert.deepEqual(endpoint, live);
    await running;
    if (operation === "apply") d.appliedVersion = 2;
  }
});

test("A restarted Render provider reconciles a pending deploy against its saved runner commit", async () => {
  const f = fixture();
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(f.deployment, f.deployment.versions[0]!), /unconfirmed deployment/);
  assert.equal((await f.store.get(f.deployment.id))!.pending!.runnerCommit, sha);
  f.finishPending();
  const restarted = f.restart("c".repeat(40));
  await restarted.apply(f.deployment, f.deployment.versions[0]!);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, 1);
  assert.equal((await f.store.get(f.deployment.id))!.pending, undefined);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

test("Render recreates an app service deleted outside QM and archives without it", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  f.deleteService();
  assert.equal(await f.provider.resolveEndpoint!(d, v1), null);
  await f.provider.destroy(d);
  assert.equal(f.credentialCalls.at(-1), "revoke");
  assert.equal((await f.store.get(d.id))!.suspended, true);
  d.status = "archived";
  assert.deepEqual(await f.provider.apply(d, v1), endpoint);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 2);
  assert.equal((await f.store.get(d.id))!.serviceId, "srv-app");
});

test("Render replaces a pending update of another version instead of waiting for it", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  f.outcome = "build_in_progress";
  await assert.rejects(f.provider.apply(d, v1), /unconfirmed deployment/);
  f.outcome = "live";
  const endpoint = await f.provider.apply(d, { ...v1, version: 2 });
  assert.ok(endpoint.host);
  const record = (await f.store.get(d.id))!;
  assert.equal(record.liveVersion, 2);
  assert.equal(record.pending, undefined);
  assert.ok(f.calls.some((call) => call.method === "POST" && call.path.endsWith("/cancel")));
});

for (const failure of ["502", "200", "wrong nonce", "missing nonce", "timeout"]) {
  test(`Render restarts readiness confirmation after ${failure} interrupts healthy responses`, async () => {
    const f = fixture();
    let probes = 0;
    f.readinessResponse = async (response) => {
      probes += 1;
      const record = (await f.store.get(f.deployment.id))!;
      assert.equal(record.liveVersion, undefined);
      assert.ok(record.pending);
      if (probes !== readyProbes) return response;
      if (failure === "timeout") throw new DOMException("Readiness request timed out", "TimeoutError");
      if (failure === "wrong nonce")
        return new Response(null, { status: 204, headers: { "x-qm-render-app-ready": "old-instance" } });
      if (failure === "missing nonce") return new Response(null, { status: 204 });
      return new Response(null, { status: Number(failure) });
    };
    const endpoint = await f.provider.apply(f.deployment, f.deployment.versions[0]!);
    assert.equal(endpoint.host, "qm-private");
    assert.equal(probes, readyProbes * 2);
    const record = (await f.store.get(f.deployment.id))!;
    assert.equal(record.liveVersion, 1);
    assert.equal(record.pending, undefined);
  });
}

test("Render retains an unstable deployment for reconciliation until its public route stays ready", async () => {
  const f = fixture();
  let probes = 0;
  f.readinessResponse = (response) => (++probes % 10 === 0 ? new Response(null, { status: 502 }) : response);
  await assert.rejects(f.provider.apply(f.deployment, f.deployment.versions[0]!), (error: Error) => {
    assert.match(error.message, /unconfirmed deployment/);
    assert.match((error.cause as Error).message, /readiness returned HTTP 502/);
    return true;
  });
  const pending = (await f.store.get(f.deployment.id))!;
  assert.equal(pending.liveVersion, undefined);
  assert.ok(pending.pending?.deployId);
  assert.equal(await f.provider.resolveEndpoint!(f.deployment, f.deployment.versions[0]!), null);
  probes = 0;
  f.readinessResponse = (response) => {
    probes += 1;
    return response;
  };
  await f.restart(sha).apply(f.deployment, f.deployment.versions[0]!);
  assert.equal(probes, readyProbes);
  assert.equal((await f.store.get(f.deployment.id))!.pending, undefined);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 1);
});

test("Render waits for the new instance nonce through old responses, lost deploy replies, and restarts", async () => {
  const f = fixture();
  const d = f.deployment;
  const v1 = d.versions[0]!;
  const endpoint = await f.provider.apply(d, v1);
  d.status = "running";
  d.appliedVersion = 1;
  const firstNonce = f.manifestNonce;
  assert.match(firstNonce!, /^[a-zA-Z0-9_-]{43}$/);
  f.readinessNonce = firstNonce;
  f.loseUpdate = true;
  const v2 = { ...v1, version: 2 };
  await assert.rejects(f.provider.apply(d, v2), /unconfirmed deployment/);
  const pending = (await f.store.get(d.id))!;
  assert.equal(pending.liveVersion, 1);
  assert.notEqual(pending.pending!.readinessNonce, firstNonce);
  assert.equal(pending.pending!.readinessNonce, f.manifestNonce);
  assert.equal(f.credentialCalls.includes("revoke"), false);
  assert.equal(await f.provider.resolveEndpoint!(d, v1), null);
  f.readinessNonce = null;
  const restarted = f.restart(sha);
  assert.equal(await restarted.resolveEndpoint!(d, v1), null);
  await assert.rejects(restarted.apply(d, v2), /unconfirmed deployment/);
  assert.equal((await f.store.get(d.id))!.pending!.readinessNonce, pending.pending!.readinessNonce);
  f.readinessNonce = undefined;
  assert.deepEqual(await restarted.apply(d, v2), endpoint);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length, 2);
  assert.equal((await f.store.get(d.id))!.liveVersion, 2);
  assert.deepEqual(await restarted.resolveEndpoint!(d, v2), endpoint);
  d.appliedVersion = 2;
  f.readinessNonce = f.manifestNonce;
  const previousNonce = f.manifestNonce;
  await assert.rejects(restarted.apply(d, v2), /unconfirmed deployment/);
  assert.notEqual((await f.store.get(d.id))!.pending!.readinessNonce, previousNonce);
  f.readinessNonce = undefined;
  await f.restart(sha).apply(d, v2);
  assert.equal((await f.store.get(d.id))!.pending, undefined);
});

test("Render refuses changed service ownership and missing retained infrastructure", async () => {
  const f = fixture();
  await f.provider.apply(f.deployment, f.deployment.versions[0]!);
  f.service.environmentId = "env-other";
  const before = f.calls.length;
  await assert.rejects(
    f.provider.apply(f.deployment, { ...f.deployment.versions[0]!, version: 2 }),
    /expected gated service with a persistent disk/,
  );
  assert.equal(
    f.calls.slice(before).some((c) => c.method !== "GET"),
    false,
  );
});

test("Render resumes a dashboard-suspended service before reusing its live version", async () => {
  const f = fixture();
  const d = f.deployment;
  const version = d.versions[0]!;
  const endpoint = await f.provider.apply(d, version);
  f.service.suspended = "suspended";
  const before = f.calls.length;
  assert.deepEqual(await f.restart(sha).apply(d, version), endpoint);
  assert.equal(f.service.suspended, "not_suspended");
  assert.equal(f.calls.slice(before).filter((call) => call.path.endsWith("/resume")).length, 1);
  assert.equal(f.calls.filter((call) => call.method === "POST" && call.path === "/services").length, 1);
});

const writesSince = (f: ReturnType<typeof fixture>, mark: number) =>
  f.calls
    .slice(mark)
    .filter((call) => call.method !== "GET")
    .map((call) => `${call.method} ${call.path}`);

async function pausedApp(f: ReturnType<typeof fixture>) {
  const version = f.deployment.versions[0]!;
  const endpoint = await f.provider.apply(f.deployment, version);
  f.deployment.appliedVersion = version.version;
  await f.provider.destroy(f.deployment);
  f.deployment.status = "archived";
  return { version, endpoint };
}

test("Render resumes a suspended app with one resume, no bootstrap deploy, and fresh credentials", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  const nonce = f.manifestNonce;
  const mark = f.calls.length;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, { ...version, env: { TOKEN: "fresh" } }), endpoint);
  assert.deepEqual(writesSince(f, mark), [
    "PUT /services/srv-app/env-vars",
    "PUT /services/srv-app/secret-files",
    "PATCH /services/srv-app",
    "POST /services/srv-app/resume",
  ]);
  assert.equal(
    f.calls.slice(mark).some((call) => JSON.stringify(call.body ?? "").includes("exit 0")),
    false,
  );
  assert.equal(f.manifest.runtimeEnv.TOKEN, "fresh");
  assert.notEqual(f.manifestNonce, nonce);
  assert.deepEqual(f.credentialCalls, ["ensure", "prepare", "revoke", "repair", "prepare"]);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, version.version);
  assert.equal((await f.store.get(f.deployment.id))!.suspended, false);
});

test("Render replaces a resumed deploy of a different branch tip with the pinned runner commit", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  f.branchTip = "c".repeat(40);
  f.resumeOutcome = "build_in_progress";
  const mark = f.calls.length;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, version), endpoint);
  const writes = writesSince(f, mark);
  assert.equal(writes.at(-3), "POST /services/srv-app/resume");
  assert.match(writes.at(-2)!, /^POST \/services\/srv-app\/deploys\/dep-\d+\/cancel$/);
  assert.equal(writes.at(-1), "POST /services/srv-app/deploys");
  const created = f.calls.slice(mark).filter((call) => call.method === "POST" && call.path.endsWith("/deploys"));
  assert.equal(created.length, 1);
  assert.equal(created[0]!.body.commitId, sha);
  assert.equal((await f.store.get(f.deployment.id))!.liveVersion, version.version);
});

test("Render continues when the resume response is lost after Render accepted it", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  f.loseResume = true;
  const deploysBefore = f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, version), endpoint);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/resume")).length, 1);
  assert.equal(
    f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/deploys")).length,
    deploysBefore,
  );
});

test("Render continues when another actor resumed the service first", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  f.resumeRace = true;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, version), endpoint);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/resume")).length, 1);
  assert.equal((await f.store.get(f.deployment.id))!.suspended, false);
});

test("Render drops a refused resume, stays suspended, and resumes on the next request", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  f.refuseResume = true;
  await assert.rejects(f.restart(sha).apply(f.deployment, version), /services\/srv-app\/resume/);
  const record = (await f.store.get(f.deployment.id))!;
  assert.equal(record.pending, undefined);
  assert.equal(record.suspended, true);
  assert.equal(f.service.suspended, "suspended");
  f.refuseResume = false;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, version), endpoint);
  assert.equal((await f.store.get(f.deployment.id))!.suspended, false);
});

test("Render cancels a resumed branch-tip deploy that survived a failed attempt before it deploys the pinned commit", async () => {
  const f = fixture();
  const { version, endpoint } = await pausedApp(f);
  f.branchTip = "c".repeat(40);
  f.resumeOutcome = "build_in_progress";
  f.failNextRequest("POST", "/services/srv-app/deploys/", 503);
  await assert.rejects(f.restart(sha).apply(f.deployment, version), /503/);
  assert.equal(f.service.suspended, "not_suspended");
  const mark = f.calls.length;
  assert.deepEqual(await f.restart(sha).apply(f.deployment, version), endpoint);
  const writes = writesSince(f, mark);
  assert.match(writes[0]!, /^POST \/services\/srv-app\/deploys\/dep-\d+\/cancel$/);
  assert.equal(writes[1], "POST /services/srv-app/deploys");
  assert.equal(
    f.calls.slice(mark).some((call) => call.path.endsWith("/resume")),
    false,
  );
});
