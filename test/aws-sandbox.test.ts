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

test("concurrent provisions for one scope launch a single body", async () => {
  const fake = installFakeMicrovm();
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});
