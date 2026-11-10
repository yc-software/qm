import { test } from "node:test";
import assert from "node:assert/strict";
import { createAwsSandbox } from "../src/sandbox/aws-sandbox.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { installFakeMicrovm, type FakeMicrovm } from "./support/fake-microvm.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testMap } from "./support/test-database.ts";
import type { StoredMicrovm } from "../src/sandbox/aws-sandbox.ts";
import { createSandboxResources, type SandboxDefault, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";

function makeSandbox(fake: FakeMicrovm, opts: Record<string, unknown> = {}) {
  return createAwsSandbox({
    store: testMap(),
    ...singleProcessDeps(),
    region: "us-west-2",
    imageIdentifier: "img",
    s3Bucket: "bucket",
    api: fake.api,
    s3: fake.s3,
    fetchImpl: fake.fetchImpl,
    ...opts,
  });
}

test("profile declares the AWS MicroVM substrate with S3-backed durability", () => {
  const sb = makeSandbox(installFakeMicrovm());
  assert.equal(sb.profile.backend, "aws-microvm");
  assert.equal(sb.profile.writablePersistence, "snapshot_to_workspace");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("first provision launches a body (cold) and run() execs over the daemon", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(scopeId("personal", "U1"));
  assert.equal(h.rootDir, "/root/workspace");
  assert.equal(h.homeDir, "/root");
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");
});

test("an already-aborted command neither resumes the body nor executes", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(scopeId("personal", "U-aborted"));
  await sb.teardown(h);
  const commandCount = fake.commands.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sb.run(h, "echo should-not-run", { signal: controller.signal }), /aborted/i);
  assert.equal(fake.bodies.get(h.id)!.state, "SUSPENDED");
  assert.equal(fake.commands.length, commandCount);
});

test("declared credential paths are symlinked outside the snapshotted home", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, {
    snapshotIntervalMs: 0,
    credentialPaths: [
      { path: ".acmecli", kind: "directory" },
      { path: ".acme/token.json", kind: "file" },
    ],
  });
  const handle = await sb.provision(scopeId("personal", "U-creds"));
  const setup = fake.commands.find((command) => command.includes("/tmp/agent-creds/.acmecli"));
  assert.ok(setup);
  assert.match(setup, /ln -s '\/tmp\/agent-creds\/\.acmecli' '\/root\/\.acmecli'/);
  await sb.teardown(handle);
  const snapshot = fake.commands.find((command) => command.includes("agent-home.tar"));
  assert.match(snapshot ?? "", /-path '\.\/\.acmecli'/);
  assert.match(snapshot ?? "", /-path '\.\/\.acme\/token\.json'/);
});

test("between turns the body is suspended and the next turn resumes it warm (no relaunch)", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U2");
  const h1 = await sb.provision(scope);
  const id = h1.id;
  await sb.teardown(h1);
  assert.equal(fake.bodies.get(id)!.state, "SUSPENDED");

  const h2 = await sb.provision(scope);
  assert.equal(h2.id, id, "same body reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new body launched");
  assert.equal(fake.bodies.get(id)!.state, "RUNNING", "resumed");
});

test("durable $HOME: state survives the body dying via the S3 snapshot", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const scope = scopeId("personal", "U3");
  const h1 = await sb.provision(scope);
  await sb.writeFile(h1, "notes/todo.txt", "buy milk");
  await sb.teardown(h1);

  assert.equal(fake.s3store.size, 1, "a snapshot landed in S3");
  fake.killBody(h1.id);

  const h2 = await sb.provision(scope);
  assert.notEqual(h2.id, h1.id, "a fresh body was launched");
  assert.equal(fake.runCount, 2);
  assert.equal(h2.coldStart, false, "rehydrated from S3, so not cold");
  assert.equal(await sb.readFile(h2, "notes/todo.txt"), "buy milk");
});

test("a body nearing the 8h cap is rotated: snapshot, terminate, relaunch, rehydrate", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { rotateAfterSeconds: 0, snapshotIntervalMs: 0 });
  const scope = scopeId("personal", "U4");
  const h1 = await sb.provision(scope);
  await sb.writeFile(h1, "keep.txt", "v1");
  await sb.teardown(h1);
  await sleep(3);

  const h2 = await sb.provision(scope);
  assert.notEqual(h2.id, h1.id);
  assert.equal(fake.bodies.get(h1.id)!.state, "TERMINATED", "old body terminated");
  assert.equal(await sb.readFile(h2, "keep.txt"), "v1", "state carried across the rotation");
});

test("reapDeepIdle terminates a parked body but keeps its durable S3 state", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const scope = scopeId("personal", "U5");
  const h1 = await sb.provision(scope);
  await sb.writeFile(h1, "state.txt", "x");
  await sb.teardown(h1);
  await sleep(5);

  const { reaped } = await sb.reapDeepIdle!(1);
  assert.equal(reaped, 1);
  assert.equal(fake.bodies.get(h1.id)!.state, "TERMINATED");
  assert.equal(fake.s3store.size, 1, "durable snapshot retained for the next visit");

  const h2 = await sb.provision(scope);
  assert.equal(fake.runCount, 2, "fresh body after reap");
  assert.equal(await sb.readFile(h2, "state.txt"), "x");
});

test("a scratch box is a fresh, ephemeral body terminated on teardown", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(scopeId("personal", "U6"), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  await sb.teardown(h);
  assert.equal(fake.bodies.get(h.id)!.state, "TERMINATED", "scratch box destroyed, not parked");
  assert.equal(fake.s3store.size, 0, "scratch boxes own nothing durable");
});

test("concurrent provisions for one scope launch a single body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U7");
  const [a, b] = await Promise.all([sb.provision(scope), sb.provision(scope)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("blob staging is advertised only when the channel is actually wired", async () => {
  assert.equal(
    supportsBlobStaging(makeSandbox(installFakeMicrovm())),
    false,
    "without blobTransfer/secret/apiBaseUrl the capability must not be claimed — copyHome probes for it",
  );
  const wired = makeSandbox(installFakeMicrovm(), {
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  assert.equal(supportsBlobStaging(wired), true, "wired up, aws can move bytes by reference");
});

test("a hydrate failure terminates the fresh body instead of cold-starting over the stored snapshot", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const scope = scopeId("personal", "U7");
  const h1 = await sb.provision(scope);
  await sb.writeFile(h1, "notes/todo.txt", "buy milk");
  await sb.teardown(h1);
  fake.killBody(h1.id);

  fake.failS3Reads = true;
  await assert.rejects(() => sb.provision(scope), /hydration failed/);
  assert.equal(
    [...fake.bodies.values()].filter((b) => b.state === "RUNNING").length,
    0,
    "the half-provisioned body was terminated, not left orphaned",
  );
  assert.equal(fake.s3store.size, 1, "the stored snapshot is untouched");

  fake.failS3Reads = false;
  const h2 = await sb.provision(scope);
  assert.equal(await sb.readFile(h2, "notes/todo.txt"), "buy milk");
});

test("scope retirement terminates its body and removes only its snapshot, including after restart", async () => {
  const fake = installFakeMicrovm();
  const store = testMap<import("../src/sandbox/aws-sandbox.ts").StoredMicrovm>();
  const sb = makeSandbox(fake, { store, snapshotIntervalMs: 0 });
  const first = await sb.provision("personal:retire-one");
  const other = await sb.provision("personal:retire-other");
  await sb.teardown(first);
  await sb.teardown(other);
  assert.equal(fake.s3store.size, 2);
  await makeSandbox(fake, { store }).destroyScope!("personal:retire-one");
  assert.equal(fake.bodies.get(first.id)!.state, "TERMINATED");
  assert.equal(fake.bodies.get(other.id)!.state, "SUSPENDED");
  assert.equal(fake.s3store.size, 1);
  assert.equal(await store.get("personal:retire-one"), null);
  assert.ok(await store.get("personal:retire-other"));
  await sb.destroyScope!("personal:retire-one");
  assert.equal(fake.s3store.size, 1);
});

for (const stage of ["terminate", "snapshot"] as const) {
  test(`scope retirement retains durable recovery metadata when ${stage} deletion fails`, async () => {
    const fake = installFakeMicrovm();
    const store = testMap<import("../src/sandbox/aws-sandbox.ts").StoredMicrovm>();
    const sb = makeSandbox(fake, { store });
    const handle = await sb.provision("personal:retire-failure");
    await sb.teardown(handle);
    const terminate = fake.api.terminate;
    const send = fake.s3.send;
    if (stage === "terminate")
      fake.api.terminate = async () => {
        throw new Error("termination failed");
      };
    else
      fake.s3.send = async () => {
        throw new Error("snapshot deletion failed");
      };
    await assert.rejects(sb.destroyScope!("personal:retire-failure"), /failed/);
    assert.ok(await store.get("personal:retire-failure"));
    fake.api.terminate = terminate;
    fake.s3.send = send;
    await sb.destroyScope!("personal:retire-failure");
    assert.equal(await store.get("personal:retire-failure"), null);
  });
}

test("failed AWS readiness remains discoverable for retirement when immediate termination fails", async () => {
  const fake = installFakeMicrovm();
  const store = testMap<import("../src/sandbox/aws-sandbox.ts").StoredMicrovm>();
  const sb = makeSandbox(fake, { store });
  const wait = fake.api.waitForState;
  const terminate = fake.api.terminate;
  fake.api.waitForState = async () => {
    throw new Error("not ready");
  };
  fake.api.terminate = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(sb.provision("personal:failed-launch"), /launch .* failed/);
  const pending = await store.get("personal:failed-launch");
  assert.ok(pending?.provisioning);
  fake.api.waitForState = wait;
  await assert.rejects(sb.provision("personal:failed-launch"), /incomplete provisioning/);
  fake.api.terminate = terminate;
  await makeSandbox(fake, { store }).destroyScope!("personal:failed-launch");
  assert.equal(fake.bodies.get(pending.microvmId)!.state, "TERMINATED");
  assert.equal(await store.get("personal:failed-launch"), null);
});

test("destructive teardown of a stale AWS handle preserves a replacement scope", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const scope = "personal:stale-destroy";
  const old = await sb.provision(scope);
  await sb.teardown(old);
  fake.killBody(old.id);
  const replacement = await sb.provision(scope);
  await sb.teardown(replacement);
  await sb.teardown(old, { destroy: true });
  assert.equal(fake.bodies.get(replacement.id)!.state, "SUSPENDED");
  assert.equal(fake.s3store.size, 1);
  assert.equal((await sb.provision(scope)).id, replacement.id);
});

for (const writer of ["teardown", "reaper"] as const) {
  test(`retirement waits for an in-flight ${writer} snapshot and prevents restoration`, async () => {
    const fake = installFakeMicrovm();
    const store = testMap<import("../src/sandbox/aws-sandbox.ts").StoredMicrovm>();
    const sb = makeSandbox(fake, { store, snapshotIntervalMs: 0 });
    const scope = `personal:retire-race-${writer}`;
    const handle = await sb.provision(scope);
    await sb.writeFile(handle, "retired.txt", "must not return");
    if (writer === "reaper") {
      await sb.teardown(handle);
      await store.merge(scope, { lastActivityMs: 2, lastSnapshotMs: 1 });
    }
    const uploading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = fake.s3.send;
    fake.s3.send = async (command: unknown) => {
      if (command?.constructor.name === "CompleteMultipartUploadCommand") {
        uploading.resolve();
        await release.promise;
      }
      return send(command);
    };
    const snapshot = writer === "reaper" ? sb.reapDeepIdle!(1) : sb.teardown(handle);
    await uploading.promise;
    let retired = false;
    const retirement = sb.destroyScope!(scope).then(() => {
      retired = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retired, false);
    release.resolve();
    await Promise.all([snapshot, retirement]);
    assert.equal(fake.s3store.size, 0);
    assert.equal(await store.get(scope), null);
    const replacement = await sb.provision(scope);
    assert.equal(await sb.readFile(replacement, "retired.txt"), null);
    await sb.destroyScope!(scope);
  });
}

test("failed overlapping preparation releases only its own sandbox lease", async () => {
  const fake = installFakeMicrovm();
  let failPreparation = false;
  const sb = makeSandbox(fake, {
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (failPreparation && new URL(String(url)).pathname === "/exec") {
        failPreparation = false;
        throw new Error("injected preparation failure");
      }
      return fake.fetchImpl(url, init);
    }) as typeof fetch,
  });
  const scope = scopeId("personal", "overlapping-preparation");
  const first = await sb.provision(scope);
  failPreparation = true;
  await assert.rejects(sb.provision(scope), /injected preparation failure/);
  assert.equal(fake.bodies.get(first.id)?.state, "RUNNING");
  assert.equal(fake.s3store.size, 0);
  await sb.teardown(first);
  assert.equal(fake.bodies.get(first.id)?.state, "SUSPENDED");
});

function twoCores(fake: FakeMicrovm, opts: Record<string, unknown> = {}) {
  const store = testMap<StoredMicrovm>();
  const records = testMap<SandboxResource>();
  const defaults = testMap<SandboxDefault>();
  const live = new Set<string>();
  const core = () => {
    const aws = makeSandbox(fake, { store, ...opts });
    const resources = createSandboxResources({
      records,
      defaults,
      backends: { aws },
      defaultBackend: "aws",
      lock: createNoopAdvisoryLock(),
      canUseScope: async () => true,
      isRunLive: async (runId) => live.has(runId),
    });
    return { resources, router: createSandboxRouter({ backends: { aws }, defaultBackend: "aws", resources }) };
  };
  return { store, live, a: core(), b: core() };
}

async function heldBody(fake: FakeMicrovm, opts: Record<string, unknown> = {}) {
  const cores = twoCores(fake, opts);
  const record = await cores.a.resources.create("alice", "personal:alice", "aws");
  const handle = await cores.a.router.provision("personal:alice", { sandboxId: record.id });
  cores.live.add("run-a");
  await cores.a.resources.hold(record.id, "run-a");
  await cores.store.merge(record.backingScopeId, { lastActivityMs: 1 });
  return { ...cores, record, handle };
}

test("a body held by a live run in another core is not deep-idle reaped, however long the hold", async () => {
  const fake = installFakeMicrovm();
  const { b, handle } = await heldBody(fake);
  assert.equal((await b.router.reapDeepIdle!(60_000)).reaped, 0);
  assert.equal(fake.bodies.get(handle.id)!.state, "RUNNING");
});

test("rotation leaves a stale body alone while a live run in another core holds it", async () => {
  const fake = installFakeMicrovm();
  const { b, record, handle } = await heldBody(fake, { rotateAfterSeconds: 0 });
  const launches = fake.runCount;
  const second = await b.router.provision("personal:alice", { sandboxId: record.id });
  assert.equal(second.id, handle.id);
  assert.equal(fake.runCount, launches);
});

test("a keep-warm release leaves the body to the other core's live holder", async () => {
  const fake = installFakeMicrovm();
  const { a, b, live, record } = await heldBody(fake);
  const other = await b.router.provision("personal:alice", { sandboxId: record.id });
  live.add("run-b");
  await b.resources.hold(record.id, "run-b");
  await b.router.teardown(other, { keepWarm: await b.resources.release(record.id, "run-b") });
  await a.resources.hold(record.id, "run-a");
  assert.equal((await b.router.reapDeepIdle!(60_000)).reaped, 0);
  assert.equal(fake.bodies.get(other.id)!.state, "RUNNING");
});

test("a holder whose run died stops pinning the body: the reaper prunes it and reaps", async () => {
  const fake = installFakeMicrovm();
  const { b, live, record } = await heldBody(fake);
  live.delete("run-a");
  assert.equal((await b.router.reapDeepIdle!(60_000)).reaped, 1);
  assert.deepEqual((await b.resources.get(record.id)).holders, []);
});
