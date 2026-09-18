import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent37Sandbox } from "../src/sandbox/agent37-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { installFakeAgent37, FAKE_AGENT37_API_KEY, type FakeAgent37 } from "./support/fake-agent37.ts";
import { Agent37ApiError } from "../src/sandbox/agent37-sandbox.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const PINNED_TEMPLATE = "agent37-codex@2026.09.14b";
const EXEC_API_CAP_SEC = 780;
const COLD_WAKE_SEC = 120;
const fileCalls = (method: string) => fake.calls.filter((c) => c.method === method && c.path === "/v1/files/content");
const hostingCreate = (body: Record<string, unknown>) =>
  fake.fetchImpl("https://api.agent37.com/v1/instances", {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_AGENT37_API_KEY}` },
    body: JSON.stringify(body),
  });

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
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one/);
  assert.match(output, /two/);
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

test("a shared advisory lock prevents duplicate instances across core replicas", async () => {
  const advisoryLock = createMemoryAdvisoryLock();
  const [a, b] = await Promise.all([
    make({ advisoryLock }).provision(layers),
    make({ advisoryLock }).provision(layers),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(fake.names().filter((name) => name === a.id).length, 1);
});

test("exec on a sleeping instance wakes it without a separate start", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.sleep(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.instance(h.id)?.status, "running");
  assert.ok(!fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/start")));
});

test("exec during the sleep checkpoint retries until the freeze clears", async () => {
  const h = await sandbox.provision(layers);
  fake.sleep(h.id, { freezing: 2 });
  const r = await sandbox.run(h, "echo woke");
  assert.equal(r.stdout.trim(), "woke");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/start")).length, 2);
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
  await sandbox.run(h, "true", { timeoutMs: 700_000 });
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

test("command output is bounded and spool files are removed on rejection", async () => {
  const h = await sandbox.provision(layers);
  await assert.rejects(
    sandbox.run(h, `python3 -c "print('x' * (${17 * 1024 * 1024}), end='')"`),
    /output exceeds 16777216 bytes/,
  );
  const leftovers = await sandbox.run(h, "ls /home/node/.qm-exec-* 2>/dev/null | wc -l");
  assert.equal(leftovers.stdout.trim(), "2", "only the inspection command's stdout/stderr spools exist");
});

test("an already-aborted command is never executed", async () => {
  const h = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sandbox.run(h, "touch should-not-exist", { signal: controller.signal }), /aborted/i);
  assert.equal(fake.execScripts().length, before);
});

test("an instance already named after the scope is adopted instead of duplicated", async () => {
  await hostingCreate({ name: sandboxScopeName("qmt", scope) });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  assert.equal(fake.names().filter((n) => n === h.id).length, 1);
  assert.deepEqual(fake.instance(h.id)?.metadata, { "qm-prefix": "qmt", "qm-scope": scope });
  assert.equal(fake.instance(h.id)?.user, scope);
});

test("timeouts beyond the API's sync exec ceiling run detached and poll to completion", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo long-path-ok; echo warn >&2; exit 9", { timeoutMs: 700_000 });
  assert.equal(r.code, 9);
  assert.equal(r.stdout.trim(), "long-path-ok");
  assert.equal(r.stderr.trim(), "warn");
  const leftovers = await sandbox.run(h, "ls /home/node/.qm-exec-*.rc 2>/dev/null | wc -l");
  assert.equal(leftovers.stdout.trim(), "0");
});

test("create pins the template release, requests the default shape, auto sleep, the idle timeout and scope tags", async () => {
  const h = await sandbox.provision(layers);
  const created = fake.instance(h.id);
  assert.equal(created?.template, PINNED_TEMPLATE);
  assert.match(PINNED_TEMPLATE, /^agent37-codex@\d{4}\.\d{2}\.\d{2}[a-z]?$/);
  assert.equal(created?.autoSleep, true);
  assert.equal(created?.idleTimeoutSeconds, 900);
  assert.deepEqual(created?.resources, { cpu: 2, memory: 4, disk: 8 });
  assert.deepEqual(created?.metadata, { "qm-prefix": "qmt", "qm-scope": scope });
  assert.equal(created?.user, scope);
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

test("the scope's instance is found by its tags, not its name", async () => {
  const h = await sandbox.provision(layers);
  fake.rename(h.id, "Renamed by an operator");
  const fresh = make();
  const again = await fresh.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.names().length, 1);
  const r = await fresh.run(again, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
});

test("scratch instances carry scratch tags and never match a scope", async () => {
  const s = await sandbox.provision(layers, { scratch: { key: "job-tags" } });
  assert.deepEqual(fake.instance(s.id)?.metadata, { "qm-prefix": "qmt", "qm-scratch": "job-tags" });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, true);
  assert.notEqual(h.id, s.id);
});

test("the idle timeout knob is sent as idle_timeout_seconds and validated against the documented range", async () => {
  const s = make({ idleTimeoutSec: 3600 });
  const h = await s.provision(layers);
  assert.equal(fake.instance(h.id)?.idleTimeoutSeconds, 3600);
  assert.throws(() => make({ idleTimeoutSec: 299 }), /AGENT37_IDLE_TIMEOUT_SEC=299 .*300 to 86400/);
  assert.throws(() => make({ idleTimeoutSec: 86_401 }), /AGENT37_IDLE_TIMEOUT_SEC=86401/);
  assert.throws(() => make({ idleTimeoutSec: 900.5 }), /AGENT37_IDLE_TIMEOUT_SEC=900.5/);
});

test("resources are validated against the fixed shapes before any instance is created", () => {
  assert.throws(() => make({ cpus: 3 }), /AGENT37_CPUS\/AGENT37_MEMORY_GB=3\/4 is not an Agent37 shape/);
  assert.throws(() => make({ cpus: 4, memoryGb: 4 }), /4\/4 is not an Agent37 shape/);
  assert.throws(() => make({ diskGb: 13 }), /AGENT37_DISK_GB=13 is outside the 2\/4 shape's 2-12 GB range/);
  assert.throws(() => make({ cpus: 8, memoryGb: 16, diskGb: 41 }), /8\/16 shape's 2-40 GB range/);
  assert.throws(() => make({ diskGb: 1 }), /AGENT37_DISK_GB=1/);
  make({ cpus: 8, memoryGb: 16, diskGb: 40 });
  make({ cpus: 4, memoryGb: 8, diskGb: 2 });
  assert.equal(fake.calls.length, 0);
});

test("a name prefix that could push an instance name past 60 characters is rejected at config time", async () => {
  assert.throws(() => make({ namePrefix: "qm-production" }), /AGENT37_NAME_PREFIX="qm-production" is too long/);
  const s = make({ namePrefix: "abcd" });
  const longScope = scopeId("channel", "T0123456789ABCDEF-C0123456789ABCDEF-U0123456789ABCDEF");
  const h = await s.provision([{ scopeId: longScope, mountPath: "/", mode: "rw" as const }], {
    scratch: { key: longScope },
  });
  assert.ok(h.id.length <= 60, h.id);
});

test("an instance limit error is reported with a clear message instead of being retried", async () => {
  fake.setInstanceLimit(0);
  await assert.rejects(sandbox.provision(layers), (e: unknown) => {
    assert.ok(e instanceof Agent37ApiError);
    assert.equal(e.code, "instance_limit_reached");
    assert.match(e.message, /instance limit/);
    assert.match(e.message, /delete instances|top up/);
    return true;
  });
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/instances").length, 1);
});

test("create waits out a documented no_capacity answer and tries again", async () => {
  fake.rejectNextCreate({ status: 503, code: "no_capacity" });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, true);
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/instances").length, 2);
});

test("an undocumented create error is surfaced with its code, not retried", async () => {
  fake.rejectNextCreate({ status: 402, code: "insufficient_balance", message: "Add balance and try again." });
  await assert.rejects(sandbox.provision(layers), (e: unknown) => {
    assert.ok(e instanceof Agent37ApiError);
    assert.equal(e.code, "insufficient_balance");
    assert.equal(e.status, 402);
    return true;
  });
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/instances").length, 1);
});

test("exec errors are branched on error.code, never on the message text", async () => {
  const h = await sandbox.provision(layers);
  fake.rejectNextExec({ status: 400, code: "forbidden", message: "Only running instances can execute commands." });
  await assert.rejects(sandbox.run(h, "echo never"), (e: unknown) => {
    assert.ok(e instanceof Agent37ApiError);
    assert.equal(e.code, "forbidden");
    return true;
  });
  assert.ok(!fake.execScripts().some((s) => /echo never/.test(s)));
});

test("exec on a waking instance is retried once it is running", async () => {
  const h = await sandbox.provision(layers);
  fake.rejectNextExec({ status: 400, code: "invalid_request", message: "The instance is waking." });
  const r = await sandbox.run(h, "echo after-wake");
  assert.equal(r.stdout.trim(), "after-wake");
});

test("exec on an instance whose wake found no capacity waits for the start to succeed", async () => {
  const h = await sandbox.provision(layers);
  fake.rejectNextExec({ status: 409, code: "capacity_unavailable" });
  const r = await sandbox.run(h, "echo placed");
  assert.equal(r.stdout.trim(), "placed");
});

test("a provisioning_failed answer while the instance is running is not retried, because the command may still be running", async () => {
  const h = await sandbox.provision(layers);
  fake.rejectNextExec({ status: 502, code: "provisioning_failed", message: "Timed out waiting for the command." });
  await assert.rejects(sandbox.run(h, "echo maybe-running"), (e: unknown) => {
    assert.ok(e instanceof Agent37ApiError);
    assert.equal(e.code, "provisioning_failed");
    assert.match(e.message, /may still be running/);
    return true;
  });
  assert.ok(!fake.execScripts().some((s) => /echo maybe-running/.test(s)));
});

test("a provisioning_failed answer from a failed wake starts the instance and retries", async () => {
  const h = await sandbox.provision(layers);
  fake.sleep(h.id);
  fake.rejectNextExec({ status: 502, code: "provisioning_failed", message: "The wake failed." });
  const r = await sandbox.run(h, "echo rewoken");
  assert.equal(r.stdout.trim(), "rewoken");
  assert.ok(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/start")));
});

test("synchronous execs leave room for a cold wake under the 780-second exec cap", async () => {
  const h = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  await sandbox.run(h, "true", { timeoutMs: 600_000 });
  await sandbox.run(h, "true", { timeoutMs: 601_000 });
  const scripts = fake.execScripts().slice(before);
  const sync = scripts.filter((s) => /\btimeout -k \d+ \d+ /.test(s) && !/nohup/.test(s));
  const detached = scripts.filter((s) => /nohup/.test(s));
  assert.equal(sync.length, 1);
  assert.equal(detached.length, 1);
  for (const s of sync) {
    const m = /\btimeout -k (\d+) (\d+) /.exec(s)!;
    assert.ok(Number(m[1]) + Number(m[2]) + COLD_WAKE_SEC <= EXEC_API_CAP_SEC, s.slice(0, 60));
  }
});

test("files move over the instance's files endpoints, not base64 exec chunks", async () => {
  const h = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
  await sandbox.writeFileBytes(h, "native.bin", big);
  const back = await sandbox.readFileBytes(h, "native.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  assert.equal(fake.execScripts().length, before);
  assert.equal(fileCalls("PUT").length, 1);
  assert.equal(fileCalls("GET").length, 1);
  assert.ok(
    fake.calls
      .filter((c) => c.path === "/v1/files/content")
      .every((c) => c.host === `${fake.instance(h.id)!.id}.agent37.app`),
  );
});

test("a missing file reads as null via the documented file_not_found code", async () => {
  const h = await sandbox.provision(layers);
  assert.equal(await sandbox.readFileBytes(h, "never-written.bin"), null);
  assert.equal(fileCalls("GET").length, 1);
});

test("file reads and writes wake a sleeping instance and start a stopped one", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "kept\n");
  fake.sleep(h.id);
  assert.equal(await sandbox.readFile(h, "keep.txt"), "kept\n");
  assert.equal(fake.instance(h.id)?.status, "running");
  fake.stop(h.id);
  await sandbox.writeFile(h, "after-stop.txt", "again\n");
  assert.equal(await sandbox.readFile(h, "after-stop.txt"), "again\n");
  assert.equal(fake.instance(h.id)?.status, "running");
});

test("export reads the archive back through the files endpoint", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "notes/a.txt", "alpha\n");
  const before = fileCalls("GET").length;
  const entries = await sandbox.exportFiles!(h, { include: ["workspace"] });
  assert.ok(entries.some((e) => e.path.endsWith("notes/a.txt")));
  assert.equal(fileCalls("GET").length, before + 1);
});

test("computer status reports the newest backup as the recovery point", async () => {
  const h = await sandbox.provision(layers);
  const none = await sandbox.computerStatus!(scope);
  assert.equal(none.provisioned, true);
  assert.equal(none.guestResponsive, true);
  assert.equal(none.lifecycleState, "running");
  assert.equal(none.recovery?.strategy, "provider_snapshot");
  assert.equal(none.recovery?.state, "none");
  fake.addBackup(h.id, "automatic", 1_789_000_000);
  fake.addBackup(h.id, "automatic", 1_789_086_400);
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.recovery?.checkpointId, fake.instance(h.id)!.backups[1]!.id);
  assert.equal(s.recovery?.checkpointAtMs, 1_789_086_400_000);
  assert.equal(s.recovery?.checkpointExpiresAtMs, null);
  assert.equal(s.recovery?.state, "automatic");
  assert.match(s.machine, /agent37 instance inst\d+: running/);
});

test("computer status does not wake a sleeping instance and reports it paused", async () => {
  const h = await sandbox.provision(layers);
  fake.sleep(h.id);
  const before = fake.execScripts().length;
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.lifecycleState, "paused");
  assert.equal(s.guestResponsive, false);
  assert.equal(fake.execScripts().length, before);
  assert.equal(fake.instance(h.id)?.status, "sleeping");
});

test("computer status without an instance says so without provisioning one", async () => {
  const s = await sandbox.computerStatus!(scope);
  assert.equal(s.provisioned, false);
  assert.equal(s.machine, "no instance");
  assert.equal(fake.names().length, 0);
});

test("restart recreates the container through the restart endpoint and waits for running", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.instance(h.id)?.restarts, 1);
  assert.equal(fake.instance(h.id)?.status, "running");
  const r = await sandbox.run(h, "echo back");
  assert.equal(r.stdout.trim(), "back");
});

test("restart of a sleeping instance wakes it first, since restart needs a running instance", async () => {
  const h = await sandbox.provision(layers);
  fake.sleep(h.id);
  await sandbox.restartComputer!(scope);
  assert.equal(fake.instance(h.id)?.restarts, 1);
  assert.equal(fake.instance(h.id)?.status, "running");
});

test("a used turn requests an on-demand backup at teardown; an untouched one does not", async () => {
  const h = await sandbox.provision(layers);
  const backups = () => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/backups")).length;
  await sandbox.teardown(h, { homeUnchanged: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backups(), 0);
  await sandbox.teardown(h);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backups(), 1);
  assert.equal(fake.instance(h.id)?.backups.length, 1);
  assert.equal(fake.instance(h.id)?.backups[0]?.kind, "manual");
});
