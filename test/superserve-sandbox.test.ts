import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfigEpochResolver,
  createSuperserveSandbox,
  SUPERSERVE_METADATA,
  type StoredConfigEpoch,
  type StoredSuperserveSandbox,
} from "../src/sandbox/superserve-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions, computerVerdict } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { setTimeout as delay } from "node:timers/promises";
import { scopeId } from "../src/types.ts";
import { installFakeSuperserve, type FakeSuperserve } from "./support/fake-superserve.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";

let fake: FakeSuperserve;
let sandbox: Sandbox;
const workspaceRoots: string[] = [];
const PROXY = "http://egress.example.com:3128";
const LOCKED = { allowOut: ["egress.example.com"], denyOut: ["0.0.0.0/0"] };

function newWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "superserve-ws-"));
  workspaceRoots.push(root);
  return createLocalWorkspaceStore(root);
}
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSuperserveSandbox(newWorkspace(), {
    store: createMemoryMap(),
    ...singleProcessDeps(),
    client: fake.client,
    namePrefix: "qmt",
    template: "qm-agent-1.0.0",
    configEpoch: 1,
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeSuperserve();
  sandbox = make();
});
afterEach(() => {
  fake?.cleanup();
  for (const root of workspaceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("profile advertises resident disk, process sessions, and the template's toolchain", () => {
  assert.equal(sandbox.profile.backend, "superserve");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(sandbox.profile.parksOnTeardown, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
  assert.equal(supportsProcessSessions(sandbox), true);
  for (const tool of ["node", "gh", "aws", "claude", "codex"])
    assert.ok(sandbox.profile.spec?.tools?.includes(tool), tool);
  assert.ok(!sandbox.profile.spec?.notInstalled?.includes("gh"));
});

test("output is capped while the command runs, and the exit code survives", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "head -c 3000000 /dev/zero | tr '\\0' a; echo err-side >&2; exit 7");
  assert.equal(r.code, 7);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
  assert.match(r.stderr, /err-side/);
  assert.match(r.stderr, /truncated/);
  const small = await sandbox.run(h, "printf ok; printf bad >&2; exit 0");
  assert.equal(small.stdout, "ok");
  assert.equal(small.stderr, "bad");
});

test("commands are run under a timeout that force-kills a process ignoring SIGTERM", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  assert.ok(fake.execScripts().some((s) => /\btimeout -k \d+ \d+ sh -c /.test(s)));
});

test("an immediate SIGKILL unrelated to the timeout deadline is not reported as timed out", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "kill -9 $$");
  assert.equal(r.code, 137);
  assert.equal(r.timedOut, false);
});

test("a command force-killed by timeout -k's own SIGKILL escalation is reported as timed out", async () => {
  const h = await sandbox.provision(layers);
  fake.beforeNextRun(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  const r = await sandbox.run(h, "kill -9 $$", { timeoutMs: 1 });
  assert.equal(r.code, 137);
  assert.equal(r.timedOut, true);
});

test("provision creates one sandbox per scope from the template with scope metadata and lifecycle limits", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  assert.equal(h.homeDir, "/root");
  assert.equal(h.rootDir, "/root/workspace");
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);

  const record = fake.current(scopeName())!;
  assert.equal(record.template, "qm-agent-1.0.0");
  assert.equal(record.metadata[SUPERSERVE_METADATA.scope], scopeName());
  assert.equal(record.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.0.0");
  assert.equal(record.metadata[SUPERSERVE_METADATA.epoch], "1");
  assert.equal(record.timeoutSeconds, 15 * 60);
  assert.equal(record.autoDeleteSeconds, 30 * 24 * 3600);
  assert.equal(record.network, undefined);

  sandbox = make({ idleParkSec: 120 });
  await sandbox.provision([{ scopeId: scopeId("personal", "other"), mountPath: "/", mode: "rw" as const }]);
  assert.equal(fake.current(sandboxScopeName("qmt", scopeId("personal", "other")))?.timeoutSeconds, 120);
});

test("an egress proxy limits the sandbox to the proxy host", async () => {
  sandbox = make({ egressProxyUrl: PROXY });
  assert.equal(sandbox.profile.egressEnforcement, "domain");
  await sandbox.provision(layers);
  assert.deepEqual(fake.current(scopeName())?.network, LOCKED);
});

test("a paused sandbox under a different egress policy is destroyed and replaced, never resumed", async () => {
  const errors: string[] = [];
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "old.txt", "stale\n");
  await sandbox.teardown(h);
  const oldId = fake.current(scopeName())!.id;

  const tightened = make({
    egressProxyUrl: PROXY,
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await tightened.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.deepEqual(fake.current(scopeName())?.network, LOCKED);
  assert.equal(fake.calls().indexOf(`connect:${oldId}`), -1, "never resumed");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_egress:policy_changed"]);
  assert.equal(await tightened.readFile(replaced, "old.txt"), null);
});

test("a paused sandbox keeps its disk when its policy can be updated without resuming", async () => {
  fake.acceptNetworkUpdateWhilePaused();
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "resident.txt", "months of work\n");
  await sandbox.teardown(h);
  const keptId = fake.current(scopeName())!.id;

  const tightened = make({ egressProxyUrl: PROXY });
  const adopted = await tightened.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.deepEqual(fake.current(scopeName())?.network, LOCKED);
  assert.equal(await tightened.readFile(adopted, "resident.txt"), "months of work\n");
  const calls = fake.calls();
  assert.ok(calls.indexOf(`update:${keptId}`) < calls.indexOf(`connect:${keptId}`), "policy lands before resume");
});

test("an unapplied policy update prevents resuming the sandbox under the old policy", async () => {
  fake.ignoreNetworkUpdateWhilePaused();
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  const oldId = fake.current(scopeName())!.id;

  await make({ egressProxyUrl: PROXY }).provision(layers);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.equal(fake.calls().indexOf(`connect:${oldId}`), -1);
});

test("a cached sandbox whose network drifted is repaired before a proxied turn", async () => {
  sandbox = make({ egressProxyUrl: PROXY });
  await sandbox.provision(layers);
  const fresh = make({ egressProxyUrl: PROXY });
  const h = await fresh.provision(layers);
  fake.current(scopeName())!.network = { allowOut: ["evil.example.com"], denyOut: [] };
  const again = await fresh.provision(layers, { egressToken: "tok" });
  assert.equal(again.coldStart, false);
  assert.deepEqual(fake.current(scopeName())?.network, LOCKED);
  assert.equal((await fresh.run(h, "echo ok")).stdout.trim(), "ok");
});

test("a sandbox built from an older template is replaced on adoption", async () => {
  const errors: string[] = [];
  const h = await sandbox.provision(layers);
  const oldId = fake.current(scopeName())!.id;
  await sandbox.teardown(h);

  const upgraded = make({
    template: "qm-agent-1.1.0",
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await upgraded.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_template:template_changed"]);

  const again = await make({ template: "qm-agent-1.1.0" }).provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("an older core never reconfigures, pauses or replaces a sandbox a newer core owns", async () => {
  const older = make({ configEpoch: 1_000 });
  await older.teardown(await older.provision(layers));

  const newer = make({ template: "qm-agent-1.1.0", configEpoch: 2_000, egressProxyUrl: PROXY, idleParkSec: 1_200 });
  await newer.teardown(await newer.provision(layers), { keepWarm: true });
  assert.equal(fake.createdCount(scopeName()), 2);
  const upgraded = fake.current(scopeName())!;
  const timeout = upgraded.timeoutSeconds;

  const olderAgain = make({ configEpoch: 1_000 });
  const h = await olderAgain.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2);
  const record = fake.current(scopeName())!;
  assert.equal(record.id, upgraded.id);
  assert.equal(record.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.equal(record.metadata[SUPERSERVE_METADATA.epoch], "2000");
  assert.deepEqual(record.network, LOCKED);
  assert.equal((await olderAgain.run(h, "echo ok")).stdout.trim(), "ok");
  await olderAgain.teardown(h);
  assert.equal(fake.current(scopeName())?.status, "active", "the older core does not pause it");
  assert.equal(fake.current(scopeName())?.timeoutSeconds, timeout);
});

test("a newer core stamps its epoch on adoption", async () => {
  await sandbox.teardown(await sandbox.provision(layers));
  await make({ configEpoch: 2 }).provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], "2");
});

test("the config epoch is claimed once per deployment generation, so a restarted core cannot outrank a newer one", async () => {
  const epochs: DurableMap<StoredConfigEpoch> = createMemoryMap();
  const lock = singleProcessDeps().advisoryLock;
  const claimed = await createConfigEpochResolver(epochs, "release-1", lock)();
  assert.equal(claimed, 1);
  assert.equal(await createConfigEpochResolver(epochs, "release-1", lock)(), claimed);
  const newRelease = await createConfigEpochResolver(epochs, "release-2", lock)();
  assert.equal(newRelease, claimed + 1);
  assert.equal(await createConfigEpochResolver(epochs, "release-1", lock)(), claimed);

  const newer = make({ configEpoch: createConfigEpochResolver(epochs, "release-2", lock) });
  await newer.provision(layers);
  const restarted = make({ configEpoch: createConfigEpochResolver(epochs, "release-1", lock) });
  await restarted.teardown(await restarted.provision(layers));
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.epoch], String(newRelease));
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("teardown pauses the sandbox; the next provision resumes it with its disk", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  await sandbox.teardown(h);
  assert.equal(fake.current(scopeName())?.status, "paused");

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await sandbox.readFile(again, "keep.txt"), "still here\n");
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("keepWarm teardown extends the active-time limit instead of pausing", async () => {
  sandbox = make({ keepWarmSec: 7_200 });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.status, "active");
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 7_200);
});

test("streams, exit codes, files and exec-backed file ops are exact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  await sandbox.importFiles!(h, [
    { path: "dir/one.txt", data: Buffer.from("1") },
    { path: "dir/two.txt", data: Buffer.from("2") },
  ]);
  assert.deepEqual((await sandbox.listDir(h, "dir")).sort(), ["dir/one.txt", "dir/two.txt"]);
  await sandbox.removeDir(h, "dir");
  assert.equal(await sandbox.readFile(h, "dir/one.txt"), null);
});

test("an already-aborted signal never executes a command", async () => {
  const handle = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  await assert.rejects(sandbox.run(handle, "echo must-not-run", { signal: AbortSignal.abort() }), /aborted/i);
  assert.equal(fake.execScripts().length, before);
});

test("provisioning the same scope twice reuses the sandbox", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("a fresh core with an empty store rediscovers the sandbox by scope metadata", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "found.txt", "yes\n");
  const restarted = make();
  const again = await restarted.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await restarted.readFile(again, "found.txt"), "yes\n");
});

test("a sandbox lost mid-session fails the command and is replaced by the next provision", async () => {
  const h = await sandbox.provision(layers);
  fake.expire(scopeName());
  await assert.rejects(sandbox.run(h, "echo x"), /is gone/);
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal((await sandbox.run(again, "echo back")).stdout.trim(), "back");
});

test("destroyScope surfaces a failed listing instead of forgetting the scope", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  await sandbox.provision(layers);
  fake.failNextList(new Error("superserve unavailable"));
  await assert.rejects(sandbox.destroyScope!(scope), /unavailable/);
  assert.ok(await store.get(scope), "record survives so retirement can be retried");
  assert.ok(fake.current(scopeName()), "sandbox untouched");
  await sandbox.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);
});

test("destroyScope also removes sandboxes only findable by metadata", async () => {
  await sandbox.provision(layers);
  await make().destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
});

test("computerStatus reports paused, running, and gone", async () => {
  assert.equal(computerVerdict(await sandbox.computerStatus!(scope)), "down");

  const h = await sandbox.provision(layers);
  const running = await sandbox.computerStatus!(scope);
  assert.equal(running.guestResponsive, true);
  assert.equal(running.lifecycleState, "running");
  assert.equal(computerVerdict(running), "ok");

  await sandbox.teardown(h);
  const paused = await sandbox.computerStatus!(scope);
  assert.equal(paused.lifecycleState, "paused");
  assert.match(paused.machine, /deleted at/);

  fake.expire(scopeName());
  const gone = await sandbox.computerStatus!(scope);
  assert.equal(gone.provisioned, false);
  assert.equal(computerVerdict(gone), "down");
});

test("restartComputer pauses and resumes the same sandbox, keeping its disk", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "kept\n");
  const id = fake.current(scopeName())!.id;
  await sandbox.restartComputer!(scope);
  assert.equal(fake.current(scopeName())?.id, id);
  assert.ok(fake.calls().includes(`pause:${id}`));
  assert.equal(fake.current(scopeName())?.status, "active");
  assert.equal(await sandbox.readFile(h, "keep.txt"), "kept\n");
});

test("scratch sandboxes are separate, shared while active, and killed on last teardown", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(a.id, b.id);
  assert.equal(a.scratch, true);
  assert.equal(b.coldStart, false);
  assert.equal(fake.current(a.id)?.autoDeleteSeconds, 24 * 3600);
  assert.equal(fake.current(a.id)?.timeoutSeconds, 10 * 60);

  await sandbox.teardown(a);
  assert.ok(fake.current(a.id), "still alive while another user holds it");
  await sandbox.teardown(b);
  assert.equal(fake.current(a.id), null);
  assert.equal(fake.current(scopeName()), null, "scratch never touches the scope sandbox");
});

test("destroying a scratch sandbox surfaces a failed kill instead of reporting success", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "creds" } });
  fake.failNextKill(new Error("superserve unavailable"));
  await assert.rejects(sandbox.teardown(h, { destroy: true }), /unavailable/);
  assert.notEqual(fake.current(h.id), null);
});

test("a best-effort scratch teardown still tolerates a failed kill", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job" } });
  fake.failNextKill(new Error("superserve unavailable"));
  await sandbox.teardown(h);
});

test("process sessions run in the background and can be read back", async () => {
  const h = await sandbox.provision(layers);
  assert.ok(supportsProcessSessions(sandbox));
  const { processId } = await sandbox.startProcess(h, "echo started; sleep 0.2; echo finished");
  let out = "";
  for (let i = 0; i < 40; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: 0 });
    out = r.chunks;
    if (r.status.state === "exited") break;
    await delay(50);
  }
  assert.match(out, /started/);
  assert.match(out, /finished/);
  assert.ok((await sandbox.listProcesses(h)).some((p) => p.processId === processId));
});

test("no access token or key ever appears in exec scripts", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  for (const script of fake.execScripts()) assert.doesNotMatch(script, /ss_live_|X-Access-Token|access_token/);
});
