import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent37Sandbox } from "../src/sandbox/agent37-sandbox.ts";
import { spriteScopeName } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeAgent37, FAKE_AGENT37_API_KEY, type FakeAgent37 } from "./support/fake-agent37.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeAgent37;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createAgent37Sandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "a37-ws-"))), {
    apiKey: FAKE_AGENT37_API_KEY,
    namePrefix: "qmt",
    fetchImpl: fake.fetchImpl,
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeAgent37();
  sandbox = make();
});
after(() => fake?.cleanup());

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);
});

test("streams and exit codes are exact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
});

test("file roundtrip incl. large binary and missing file", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  const huge = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < huge.length; i++) huge[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "huge.bin", huge);
  const hugeBack = await sandbox.readFileBytes(h, "huge.bin");
  assert.ok(hugeBack && Buffer.from(hugeBack).equals(huge));
});

test("every exec request stays under the single-argument limit of the host", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFileBytes(h, "wide.bin", Buffer.alloc(600 * 1024, 7));
  const longest = Math.max(...fake.execScripts().map((s) => Buffer.byteLength(s)));
  assert.ok(longest < 100 * 1024, `longest exec command was ${longest} bytes`);
});

test("empty file roundtrip", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFileBytes(h, "empty.bin", Buffer.alloc(0));
  const back = await sandbox.readFileBytes(h, "empty.bin");
  assert.ok(back);
  assert.equal(back.length, 0);
});

test("process sessions capability works end to end", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  let cursor = 0,
    chunks = "",
    state = "running";
  for (let i = 0; i < 10 && state === "running"; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: cursor });
    chunks += r.chunks;
    cursor = r.cursor;
    state = r.status.state;
  }
  assert.match(chunks, /one/);
  assert.match(chunks, /two/);
});

test("force-through proxy env is set when a proxy url and token are present", async () => {
  const s = make({ egressProxyUrl: "https://proxy.example.com" });
  const token = await mintCapabilityToken(
    { actorId: "tester", scopeId: scope, aud: EGRESS_PROXY_AUD, exp: Date.now() + 600_000 },
    "secret",
  );
  const h = await s.provision(layers, { egressToken: token });
  const r = await s.run(h, "echo PROXY=$HTTPS_PROXY");
  assert.match(r.stdout, /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
});

test("no proxy env without a proxy url", async () => {
  const h = await sandbox.provision(layers, { egressToken: "ignored" });
  assert.equal(h.env?.HTTPS_PROXY, undefined);
});

test("instance is reused across provisions and warm start is reported", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.names().filter((n) => n === a.id).length, 1);
});

test("exec on a sleeping instance wakes it and retries", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.sleep(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.instance(h.id)?.status, "running");
  assert.ok(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/start")));
});

test("exec during the sleep checkpoint retries start until the freeze clears", async () => {
  const h = await sandbox.provision(layers);
  fake.sleep(h.id, { freezing: 2 });
  const r = await sandbox.run(h, "echo woke");
  assert.equal(r.stdout.trim(), "woke");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/start")).length, 3);
});

test("exec on a stopping instance waits for it to stop, then starts it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.stop(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.instance(h.id)?.status, "running");
});

test("a failed instance is surfaced, not replaced, and destroy deletes it", async () => {
  const h = await sandbox.provision(layers);
  fake.fail(h.id);
  const fresh = make();
  await assert.rejects(fresh.provision(layers), /failed/);
  assert.equal(fake.names().filter((n) => n === h.id).length, 1);
  await fresh.teardown(h, { destroy: true });
  assert.equal(fake.instance(h.id), null);
});

test("every timed exec carries a kill-after so a TERM-ignoring command cannot outlive the API's ceiling", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true", { timeoutMs: 60_000 });
  await sandbox.run(h, "true", { timeoutMs: 400_000 });
  const timed = fake.execScripts().filter((s) => /\btimeout /.test(s));
  assert.ok(timed.length >= 2);
  assert.ok(timed.every((s) => /\btimeout -k 5 \d+ /.test(s)));
});

test("scratch instances are created on demand and deleted at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.ok(fake.instance(h.id));
  await sandbox.teardown(h);
  assert.equal(fake.instance(h.id), null);
});

test("teardown without destroy keeps the instance; destroy deletes it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.ok(fake.instance(h.id));
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.instance(h.id), null);
});

test("large command output survives the API's output cap exactly", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "python3 -c \"print('x' * (900 * 1024), end='')\"");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 900 * 1024);
  assert.equal(r.stdout, "x".repeat(900 * 1024));
});

test("an instance already named after the scope is adopted instead of duplicated", async () => {
  await fake.fetchImpl("https://api.agent37.com/v1/instances", {
    method: "POST",
    body: JSON.stringify({ name: spriteScopeName("qmt", scope) }),
  });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  assert.equal(fake.names().filter((n) => n === h.id).length, 1);
});

test("timeouts beyond the API's sync exec ceiling run detached and poll to completion", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo long-path-ok; echo warn >&2; exit 9", { timeoutMs: 400_000 });
  assert.equal(r.code, 9);
  assert.equal(r.stdout.trim(), "long-path-ok");
  assert.equal(r.stderr.trim(), "warn");
  const leftovers = await sandbox.run(h, "ls /home/node/.qm-exec-*.rc 2>/dev/null | wc -l");
  assert.equal(leftovers.stdout.trim(), "0");
});

test("create requests the template, the default shape and no auto sleep", async () => {
  const h = await sandbox.provision(layers);
  const created = fake.instance(h.id);
  assert.equal(created?.template, "agent37-qm-computer");
  assert.equal(created?.autoSleep, false);
  assert.deepEqual(created?.resources, { cpu: 2, memory: 4, disk: 8 });
});

test("configured resources are requested at create and advertised in the profile", async () => {
  const s = make({ template: "my-computer", cpus: 4, memoryGb: 8, diskGb: 20 });
  const h = await s.provision(layers);
  assert.equal(fake.instance(h.id)?.template, "my-computer");
  assert.deepEqual(fake.instance(h.id)?.resources, { cpu: 4, memory: 8, disk: 20 });
  assert.equal(s.profile.spec?.cpus, 4);
  assert.equal(s.profile.spec?.memoryMb, 8192);
  assert.equal(s.profile.spec?.diskGb, 20);
});

test("profile advertises resident disk and process sessions", () => {
  assert.equal(sandbox.profile.backend, "agent37");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
});
