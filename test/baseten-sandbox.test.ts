import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBasetenSandbox } from "../src/sandbox/baseten-sandbox.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { supportsProcessSessions, type Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { FAKE_BASETEN_API, installFakeBaseten, type FakeBaseten } from "./support/fake-baseten-sandboxes.ts";

let fake: FakeBaseten;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createBasetenSandbox({
    advisoryLock: createNoopAdvisoryLock(),
    apiKey: "bt_test_key",
    image: "qm-sandbox-abc:latest",
    namePrefix: "qmt",
    apiUrl: FAKE_BASETEN_API,
    fetchImpl: fake.fetchImpl,
    ...extra,
  });
}

beforeEach(() => {
  fake?.cleanup();
  fake = installFakeBaseten();
  sandbox = make();
});
after(() => fake?.cleanup());

test("provision creates the named sandbox from the configured image and runs commands in the workspace", async () => {
  const h = await sandbox.provision(scope, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  assert.deepEqual(fake.box(h.id), { status: "DEPLOYED", image: "qm-sandbox-abc:latest", memory: 8192 });
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\/root\/workspace\n/);
  assert.match(r.stdout, /VAR=v1/);
  const again = await make().provision(scope);
  assert.equal(again.id, h.id);
  assert.equal(again.coldStart, false);
  assert.deepEqual(fake.names(), [h.id]);
});

test("streams and exit codes are exact", async () => {
  const h = await sandbox.provision(scope);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.timedOut, false);
});

test("a command whose request the edge cuts off, or that outlives the request, still returns its result", async () => {
  const h = await sandbox.provision(scope);
  fake.cutOffNextExec();
  const cut = await sandbox.run(h, "echo cut; exit 2", { timeoutMs: 600_000 });
  assert.equal(cut.code, 2);
  assert.equal(cut.stdout, "cut\n");
  fake.returnNextExecRunning();
  const long = await sandbox.run(h, "echo long", { timeoutMs: 600_000 });
  assert.equal(long.code, 0);
  assert.equal(long.stdout, "long\n");
});

test("a command whose connection drops after it ran returns its result and runs once", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "count.txt", "");
  fake.dropNextExecConnection();
  const r = await sandbox.run(h, "echo x >> count.txt; echo ran; exit 4");
  assert.equal(r.code, 4);
  assert.equal(r.stdout, "ran\n");
  assert.equal(await sandbox.readFile(h, "count.txt"), "x\n");
});

test("a command refused before it starts runs once the sandbox answers", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "count.txt", "");
  fake.refuseNextExec();
  const r = await sandbox.run(h, "echo x >> count.txt; echo ran");
  assert.equal(r.stdout, "ran\n");
  assert.equal(await sandbox.readFile(h, "count.txt"), "x\n");
});

test("a process that ends without an exit code is reported with its status", async () => {
  const h = await sandbox.provision(scope);
  fake.dropNextExitCode();
  await assert.rejects(
    sandbox.run(h, "echo partial; echo oops >&2"),
    /process ended with status killed and no exit code; stdout: partial\n; stderr: oops\n/,
  );
});

test("a sandbox Baseten deleted at its 7-day limit is recreated empty on the next provision", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "old.txt", "x");
  fake.expire(h.id);
  await assert.rejects(make().run(h, "true"), /gone; the next provision creates a replacement/);
  const again = await sandbox.provision(scope);
  assert.equal(again.coldStart, true);
  assert.equal(again.id, h.id);
  assert.equal(await sandbox.readFile(again, "old.txt"), null);
  assert.equal((await sandbox.run(again, "echo back")).stdout, "back\n");
});

test("a scope provisioned again while its old sandbox is still deleting gets a fresh sandbox", async () => {
  fake.slowDeletes();
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "old.txt", "x");
  await sandbox.destroyScope!(scope);
  assert.equal(fake.box(h.id)?.status, "DELETING");
  const again = await sandbox.provision(scope);
  assert.equal(again.coldStart, true);
  assert.equal(fake.box(h.id)?.status, "DEPLOYED");
  assert.equal(await sandbox.readFile(again, "old.txt"), null);
});

test("a core holding a sandbox another core destroyed recovers on the next provision", async () => {
  const coreA = make();
  const coreB = make();
  const h = await coreA.provision(scope);
  await coreB.destroyScope!(scope);
  await assert.rejects(coreA.run(h, "true"));
  await assert.rejects(coreA.run(h, "true"), /gone; the next provision creates a replacement/);
  const again = await coreA.provision(scope);
  assert.equal(again.coldStart, true);
  assert.equal((await coreA.run(again, "echo back")).stdout, "back\n");
});

test("file roundtrip incl. binary, empty and missing files", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "a/b c.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b c.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  await sandbox.writeFileBytes(h, "empty.bin", Buffer.alloc(0));
  assert.equal((await sandbox.readFileBytes(h, "empty.bin"))?.length, 0);
  assert.equal((await sandbox.run(h, "cat 'a/b c.txt'")).stdout, "hello\n");
});

test("process sessions work end to end", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(scope);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one\ntwo/);
});

test("a terminated or failed sandbox is replaced on the next provision", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.writeFile(h, "kept.txt", "x");
  fake.setStatus(h.id, "TERMINATED");
  const replaced = await make().provision(scope);
  assert.equal(replaced.coldStart, true);
  assert.equal(await make().readFile(replaced, "kept.txt"), null);
  fake.setStatus(h.id, "FAILED");
  const again = await make().provision(scope);
  assert.equal(again.coldStart, true);
  assert.equal(fake.box(h.id)?.status, "DEPLOYED");
});

test("teardown keeps the sandbox, destroy and destroyScope delete it", async () => {
  const h = await sandbox.provision(scope);
  await sandbox.teardown(h);
  assert.equal(fake.box(h.id)?.status, "DEPLOYED");
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.box(h.id)?.status, "TERMINATED");
  const second = await sandbox.provision(scope);
  await sandbox.destroyScope!(scope);
  assert.equal(fake.box(second.id)?.status, "TERMINATED");
});

test("scratch sandboxes are created on demand and deleted at release", async () => {
  const h = await sandbox.provision(scope, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.box(h.id)?.status, "DEPLOYED");
  await sandbox.teardown(h);
  assert.equal(fake.box(h.id)?.status, "TERMINATED");
});

test("sandbox names fit the 49-character limit", async () => {
  const long = scopeId("personal", "a-very-long-person-identifier-for-name-length@example-company.com");
  const h = await sandbox.provision(long);
  assert.ok(h.id.length <= 49, h.id);
  const scratch = await sandbox.provision(long, { scratch: { key: "a-long-scratch-key-for-a-background-job-0001" } });
  assert.ok(scratch.id.length <= 49, scratch.id);
  await sandbox.destroyScope!(long);
  assert.equal(fake.box(h.id)?.status, "TERMINATED");
});

test("missing credentials or image fail at construction", () => {
  assert.throws(() => make({ apiKey: undefined }), /BASETEN_API_KEY/);
  assert.throws(() => make({ image: undefined }), /BASETEN_SANDBOX_IMAGE/);
});
