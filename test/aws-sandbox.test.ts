import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsSandbox } from "../src/sandbox/aws-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { installFakeMicrovm, type FakeMicrovm } from "./support/fake-microvm.ts";

function makeSandbox(fake: FakeMicrovm, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aws-ws-"));
  return createAwsSandbox(createLocalWorkspaceStore(dir), {
    region: "us-west-2",
    imageIdentifier: "img",
    s3Bucket: "bucket",
    api: fake.api,
    s3: fake.s3,
    fetchImpl: fake.fetchImpl,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

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
  const h = await sb.provision(rw(scopeId("personal", "U1")));
  assert.equal(h.rootDir, "/root/workspace");
  assert.equal(h.homeDir, "/root");
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");
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
  const handle = await sb.provision(rw(scopeId("personal", "U-creds")));
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
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  const id = h1.id;
  await sb.teardown(h1);
  assert.equal(fake.bodies.get(id)!.state, "SUSPENDED");

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, id, "same body reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new body launched");
  assert.equal(fake.bodies.get(id)!.state, "RUNNING", "resumed");
});

test("durable $HOME: state survives the body dying via the S3 snapshot", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await sb.provision(layers);
  await sb.writeFile(h1, "notes/todo.txt", "buy milk");
  await sb.teardown(h1);

  assert.equal(fake.s3store.size, 1, "a snapshot landed in S3");
  fake.killBody(h1.id);

  const h2 = await sb.provision(layers);
  assert.notEqual(h2.id, h1.id, "a fresh body was launched");
  assert.equal(fake.runCount, 2);
  assert.equal(h2.coldStart, false, "rehydrated from S3, so not cold");
  assert.equal(await sb.readFile(h2, "notes/todo.txt"), "buy milk");
});

test("a body nearing the 8h cap is rotated: snapshot, terminate, relaunch, rehydrate", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { rotateAfterSeconds: 0, snapshotIntervalMs: 0 });
  const layers = rw(scopeId("personal", "U4"));
  const h1 = await sb.provision(layers);
  await sb.writeFile(h1, "keep.txt", "v1");
  await sb.teardown(h1);
  await sleep(3);

  const h2 = await sb.provision(layers);
  assert.notEqual(h2.id, h1.id);
  assert.equal(fake.bodies.get(h1.id)!.state, "TERMINATED", "old body terminated");
  assert.equal(await sb.readFile(h2, "keep.txt"), "v1", "state carried across the rotation");
});

test("reapDeepIdle terminates a parked body but keeps its durable S3 state", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { snapshotIntervalMs: 0 });
  const layers = rw(scopeId("personal", "U5"));
  const h1 = await sb.provision(layers);
  await sb.writeFile(h1, "state.txt", "x");
  await sb.teardown(h1);
  await sleep(5);

  const { reaped } = await sb.reapDeepIdle!(1);
  assert.equal(reaped, 1);
  assert.equal(fake.bodies.get(h1.id)!.state, "TERMINATED");
  assert.equal(fake.s3store.size, 1, "durable snapshot retained for the next visit");

  const h2 = await sb.provision(layers);
  assert.equal(fake.runCount, 2, "fresh body after reap");
  assert.equal(await sb.readFile(h2, "state.txt"), "x");
});

test("a scratch box is a fresh, ephemeral body terminated on teardown", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U6")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  await sb.teardown(h);
  assert.equal(fake.bodies.get(h.id)!.state, "TERMINATED", "scratch box destroyed, not parked");
  assert.equal(fake.s3store.size, 0, "scratch boxes own nothing durable");
});

test("an authority-free scratch box launches without configured egress connectors or an execution role", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { imageVersion: "3", executionRoleArn: "arn:aws:iam::123456789012:role/runtime" });
  const handle = await sb.provision([], { scratch: { key: "authority-free" }, executionAuthority: "none" });
  assert.deepEqual(fake.runInputs[0]?.egressNetworkConnectors, []);
  assert.equal(fake.runInputs[0]?.executionRoleArn, undefined);
  assert.equal(handle.backend, "aws");
  assert.equal(handle.executionAuthority, "none");
  assert.match(handle.imageIdentifier ?? "", /^arn:aws:lambda:/);
  assert.equal(handle.imageVersion, "3");
  fake.bodies.get(handle.id)!.fs.set("/usr/local/bin/sample-tool", Buffer.from("installed bytes"));
  const installed = await sb.readInstalledExecutable!(handle, "sample-tool");
  assert.ok(installed);
  assert.equal(Buffer.from(installed).toString("utf8"), "installed bytes");
  await assert.rejects(() => sb.readInstalledExecutable!(handle, "../sample-tool"), /invalid installed executable/);
  await sb.teardown(handle, { destroy: true });
});

test("an authority-free scratch box requires provider-observed image provenance and no provider role", async (t) => {
  const expectedArn = "arn:aws:lambda:us-west-2:0:microvm-image:img";
  const cases: Array<{
    name: string;
    transform: (
      value: Awaited<ReturnType<FakeMicrovm["api"]["runMicrovm"]>>,
    ) => Awaited<ReturnType<FakeMicrovm["api"]["runMicrovm"]>>;
    pattern: RegExp;
  }> = [
    {
      name: "missing image ARN",
      transform: ({ imageArn: _, ...value }) => value,
      pattern: /image ARN does not match/,
    },
    {
      name: "wrong image ARN",
      transform: (value) => ({ ...value, imageArn: `${expectedArn}-other` }),
      pattern: /image ARN does not match/,
    },
    {
      name: "missing image version",
      transform: ({ imageVersion: _, ...value }) => value,
      pattern: /image version does not match/,
    },
    {
      name: "wrong image version",
      transform: (value) => ({ ...value, imageVersion: "other-version" }),
      pattern: /image version does not match/,
    },
    {
      name: "unexpected execution role",
      transform: (value) => ({ ...value, executionRoleArn: "arn:aws:iam::123456789012:role/unexpected" }),
      pattern: /unexpectedly has an execution role/,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fake = installFakeMicrovm();
      const runMicrovm = fake.api.runMicrovm.bind(fake.api);
      const waitForState = fake.api.waitForState.bind(fake.api);
      fake.api.runMicrovm = async (input) => entry.transform(await runMicrovm(input));
      fake.api.waitForState = async (id, target, options) => entry.transform(await waitForState(id, target, options));
      const sb = makeSandbox(fake, { imageVersion: "provider-revision-3" });
      await assert.rejects(
        () => sb.provision([], { scratch: { key: entry.name }, executionAuthority: "none" }),
        entry.pattern,
      );
      assert.equal(fake.runInputs[0]?.imageIdentifier, expectedArn);
      assert.equal(fake.runInputs[0]?.imageVersion, "provider-revision-3");
      assert.equal([...fake.bodies.values()][0]?.state, "TERMINATED");
    });
  }
});

test("scratch cache identity includes execution authority and cannot relabel a default body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake, { executionRoleArn: "arn:aws:iam::123456789012:role/runtime" });
  const normal = await sb.provision([], { scratch: { key: "same-key" } });
  const authorityFree = await sb.provision([], { scratch: { key: "same-key" }, executionAuthority: "none" });
  assert.notEqual(normal.id, authorityFree.id);
  assert.equal(fake.runCount, 2);
  assert.notDeepEqual(fake.runInputs[0]?.egressNetworkConnectors, []);
  assert.equal(fake.runInputs[0]?.executionRoleArn, "arn:aws:iam::123456789012:role/runtime");
  assert.deepEqual(fake.runInputs[1]?.egressNetworkConnectors, []);
  assert.equal(fake.runInputs[1]?.executionRoleArn, undefined);
  assert.equal(normal.executionAuthority, undefined);
  assert.equal(authorityFree.executionAuthority, "none");
  const authorityFreeFirst = await sb.provision([], {
    scratch: { key: "reverse-key" },
    executionAuthority: "none",
  });
  const normalSecond = await sb.provision([], { scratch: { key: "reverse-key" } });
  assert.notEqual(authorityFreeFirst.id, normalSecond.id);
  assert.deepEqual(fake.runInputs[2]?.egressNetworkConnectors, []);
  assert.equal(fake.runInputs[2]?.executionRoleArn, undefined);
  assert.notDeepEqual(fake.runInputs[3]?.egressNetworkConnectors, []);
  assert.equal(fake.runInputs[3]?.executionRoleArn, "arn:aws:iam::123456789012:role/runtime");
  await sb.teardown(normal, { destroy: true });
  await sb.teardown(authorityFree, { destroy: true });
  await sb.teardown(authorityFreeFirst, { destroy: true });
  await sb.teardown(normalSecond, { destroy: true });
});

test("distinct scratch keys produce authority-bound distinct AWS idempotency tokens at the same clock instant", async (t) => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  t.mock.method(Date, "now", () => 42);
  const [first, second, unusual] = await Promise.all([
    sb.provision([], { scratch: { key: "first" }, executionAuthority: "none" }),
    sb.provision([], { scratch: { key: "second" }, executionAuthority: "none" }),
    sb.provision([], { scratch: { key: `${"long/unsafe key:".repeat(100)}\n` }, executionAuthority: "none" }),
  ]);
  assert.notEqual(fake.runInputs[0]?.clientToken, fake.runInputs[1]?.clientToken);
  assert.match(fake.runInputs[0]?.clientToken ?? "", /^authority-none-[0-9a-f-]{36}$/);
  assert.match(fake.runInputs[1]?.clientToken ?? "", /^authority-none-[0-9a-f-]{36}$/);
  assert.match(fake.runInputs[2]?.clientToken ?? "", /^authority-none-[0-9a-f-]{36}$/);
  assert.ok((fake.runInputs[2]?.clientToken?.length ?? 0) < 64);
  await sb.teardown(first, { destroy: true });
  await sb.teardown(second, { destroy: true });
  await sb.teardown(unusual, { destroy: true });
});

test("concurrent provisions for one scope launch a single body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});
