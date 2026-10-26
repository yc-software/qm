import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsSandbox, type StoredMicrovm } from "../src/sandbox/aws-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { installFakeMicrovm, type FakeMicrovm } from "./support/fake-microvm.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";

function makeSandbox(fake: FakeMicrovm, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aws-ws-"));
  const store = (opts.store as DurableMap<StoredMicrovm> | undefined) ?? createMemoryMap<StoredMicrovm>();
  const sb = createAwsSandbox(createLocalWorkspaceStore(dir), {
    ...singleProcessDeps(),
    region: "us-west-2",
    imageIdentifier: "img",
    api: fake.api,
    fetchImpl: fake.fetchImpl,
    ...opts,
    store,
  });
  const vm = async (scope: string) => fake.bodies.get((await store.get(scope))!.microvmId!)!;
  return Object.assign(sb, { store, vm });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("profile declares the AWS MicroVM substrate with a resident disk", () => {
  const sb = makeSandbox(installFakeMicrovm());
  assert.equal(sb.profile.backend, "aws");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(sb.profile.parksOnTeardown, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("first provision launches a body (cold) and run() execs over the daemon", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U1")));
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
  const scope = scopeId("personal", "U-aborted");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h);
  const commandCount = fake.commands.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sb.run(h, "echo should-not-run", { signal: controller.signal }), /aborted/i);
  assert.equal((await sb.vm(scope)).state, "SUSPENDED");
  assert.equal(fake.commands.length, commandCount);
});

test("declared credential paths are symlinked outside the home", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, {
    credentialPaths: [
      { path: ".acmecli", kind: "directory" },
      { path: ".acme/token.json", kind: "file" },
    ],
  });
  const handle = await sb.provision(rw(scopeId("personal", "U-creds")));
  const setup = fake.commands.find((command) => command.includes("/tmp/agent-creds/.acmecli"));
  assert.ok(setup);
  assert.match(setup, /ln -s '\/tmp\/agent-creds\/\.acmecli' '\/root\/\.acmecli'/);
  await sb.teardown(handle);
});

test("between turns the body is suspended and the next turn resumes it warm (no relaunch)", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U2");
  const h1 = await sb.provision(rw(scope));
  const body = await sb.vm(scope);
  await sb.teardown(h1);
  assert.equal(body.state, "SUSPENDED");

  const h2 = await sb.provision(rw(scope));
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new body launched");
  assert.equal(await sb.run(h2, "true").then((r) => r.code), 0);
  assert.equal(body.state, "RUNNING", "resumed");
});

test("a turn that ends while another is still running does not suspend the body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U-overlap");
  const a = await sb.provision(rw(scope));
  const b = await sb.provision(rw(scope));
  await sb.teardown(a);
  assert.equal((await sb.vm(scope)).state, "RUNNING");
  await sb.teardown(b);
  assert.equal((await sb.vm(scope)).state, "SUSPENDED");
});

test("a body past its maximum lifetime is terminated and replaced by a fresh one", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { maxLifetimeSec: 1 });
  const scope = scopeId("personal", "U4");
  const h1 = await sb.provision(rw(scope));
  const first = await sb.vm(scope);
  await sb.teardown(h1);
  const h2 = await sb.provision(rw(scope));
  assert.equal(first.state, "TERMINATED", "old body terminated");
  assert.notEqual((await sb.vm(scope)).id, first.id);
  assert.equal(h2.coldStart, true);
});

test("idle and lifetime settings reach the microVM idle policy", async () => {
  const fake = installFakeMicrovm();
  const runs: unknown[] = [];
  const run = fake.api.runMicrovm;
  fake.api.runMicrovm = async (input) => {
    runs.push(input);
    return run(input);
  };
  const sb = makeSandbox(fake, { idleParkSec: 120, maxLifetimeSec: 7200 });
  await sb.provision(rw(scopeId("personal", "U-policy")));
  assert.deepEqual((runs[0] as { idlePolicy: unknown }).idlePolicy, {
    autoResumeEnabled: true,
    maxIdleDurationSeconds: 120,
    suspendedDurationSeconds: 3600,
  });
  assert.equal((runs[0] as { maximumDurationInSeconds: number }).maximumDurationInSeconds, 7200);
});

test("a scratch box is a fresh, ephemeral body terminated on teardown", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U6")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  await sb.teardown(h);
  assert.deepEqual(
    [...fake.bodies.values()].map((b) => b.state),
    ["TERMINATED"],
    "scratch box destroyed, not parked",
  );
});

test("concurrent provisions for one scope launch a single body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
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

test("scope retirement terminates only its body and forgets its record, including from another process", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const first = await sb.provision(rw("personal:retire-one"));
  const other = await sb.provision(rw("personal:retire-other"));
  const firstBody = await sb.vm("personal:retire-one");
  const otherBody = await sb.vm("personal:retire-other");
  await sb.teardown(first);
  await sb.teardown(other);
  await makeSandbox(fake, { store: sb.store }).destroyScope!("personal:retire-one");
  assert.equal(firstBody.state, "TERMINATED");
  assert.equal(otherBody.state, "SUSPENDED");
  assert.equal(await sb.store.get("personal:retire-one"), null);
  assert.ok(await sb.store.get("personal:retire-other"));
  await sb.destroyScope!("personal:retire-one");
});

test("scope retirement retains durable recovery metadata when terminate fails", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const handle = await sb.provision(rw("personal:retire-failure"));
  await sb.teardown(handle);
  const terminate = fake.api.terminate;
  fake.api.terminate = async () => {
    throw new Error("termination failed");
  };
  await assert.rejects(sb.destroyScope!("personal:retire-failure"), /failed/);
  assert.ok(await sb.store.get("personal:retire-failure"));
  fake.api.terminate = terminate;
  await sb.destroyScope!("personal:retire-failure");
  assert.equal(await sb.store.get("personal:retire-failure"), null);
});

test("a launch that never became ready stays recorded and is resumed or retired later", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const scope = "personal:failed-launch";
  const wait = fake.api.waitForState;
  const terminate = fake.api.terminate;
  fake.api.waitForState = async () => {
    throw new Error("not ready");
  };
  fake.api.terminate = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(sb.provision(rw(scope)), /launch .* failed/);
  const pending = await sb.store.get(scope);
  assert.ok(pending?.microvmId);
  assert.equal(pending.initializationPending, true);
  fake.api.waitForState = wait;
  fake.api.terminate = terminate;
  const h = await sb.provision(rw(scope));
  assert.equal((await sb.store.get(scope))?.microvmId, pending.microvmId);
  assert.equal((await sb.store.get(scope))?.initializationPending, undefined);
  await sb.teardown(h);
  await makeSandbox(fake, { store: sb.store }).destroyScope!(scope);
  assert.equal(fake.bodies.get(pending.microvmId)!.state, "TERMINATED");
  assert.equal(await sb.store.get(scope), null);
});

test("failed overlapping preparation leaves the running body alone", async () => {
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
  const first = await sb.provision(rw(scope));
  failPreparation = true;
  await assert.rejects(sb.provision(rw(scope)), /injected preparation failure/);
  assert.equal((await sb.vm(scope)).state, "RUNNING");
  await sb.teardown(first);
  assert.equal((await sb.vm(scope)).state, "SUSPENDED");
});
