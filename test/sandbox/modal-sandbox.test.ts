import { pollProcess } from "../../src/sandbox/process-poll.ts";
import type { SandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { test, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModalSandbox, MODAL_BODIES, type StoredModalSandbox } from "../../src/sandbox/modal-sandbox.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createSandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { sandboxScopeName } from "../../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../../src/sandbox/sandbox.ts";
import { scopeId } from "../../src/types.ts";
import { tenant } from "../../src/tenant.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../../src/auth/capability-token.ts";
import { installFakeModal, type FakeModal } from "../support/fake-modal.ts";
import { MODAL_CHECKPOINT_RETENTION_MS, type ModalClient } from "../../src/sandbox/modal-client.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { testAdvisoryLock, testDatabaseUrl, testSandboxBodies } from "../support/test-database.ts";

let fake: FakeModal;
let sandbox: Sandbox;
let store: SandboxBodies<StoredModalSandbox>;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createModalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "modal-ws-"))), {
    store,
    advisoryLock: createNoopAdvisoryLock(),
    client: fake.client,
    tenantConfig: () => ({ sandboxNamePrefix: "qmt" }),
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeModal();
  store = testSandboxBodies(MODAL_BODIES);
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
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
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
  const r = await s.run(h, "echo PROXY=$HTTPS_PROXY; echo $GIT_HTTP_PROXY_AUTHMETHOD");
  assert.match(r.stdout, /PROXY=https?:\/\/[^ ]*proxy\.example\.com/);
  assert.match(r.stdout, /^basic$/m);
});

test("an existing live sandbox holding the scope name is adopted after a restart", async () => {
  await make({ store: testSandboxBodies(MODAL_BODIES) }).provision(layers);
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
});

test("scratch sandboxes are unnamed, ephemeral, and terminated at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.createdCount(scopeName()), 0, "a scratch box must not claim the scope name");
  assert.equal(fake.runningCount(), 1);
  await sandbox.teardown(h);
  assert.equal(fake.runningCount(), 0);
});

test("a terminated sandbox falls back to a fresh one with home hydrated from the snapshot", async () => {
  const a = await sandbox.provision(layers);
  await sandbox.writeFile(a, "keep.txt", "survives the kill\n");
  await sandbox.teardown(a);
  fake.terminate(a.id);
  const b = await sandbox.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal(await sandbox.readFile(b, "keep.txt"), "survives the kill\n");
  const r = await sandbox.run(b, "echo revived");
  assert.equal(r.stdout.trim(), "revived");
});

test("rotation snapshots changes written since the last teardown snapshot", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.teardown(a);
  await s.writeFile(a, "late.txt", "written after teardown\n");
  await store.update(scope, { expiresAtMs: Date.now() + 3600_000 });
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "late.txt"), "written after teardown\n");
});

test("computerStatus probes the guest", async () => {
  await sandbox.provision(layers);
  assert.ok(sandbox.computerStatus);
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.guestResponsive, true);
  assert.equal(status.provisioned, true);
  assert.match(status.machine, /modal sandbox sb-/);
});

test("computerStatus reports a gone sandbox as unprovisioned, not wedged", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.terminate(h.id);
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.guestResponsive, false);
  assert.equal(status.provisioned, false, "a sandbox the platform says is gone needs a re-provision, not a restart");
});

test("reapDeepIdle spares a box running a detached background job", async () => {
  const s = make();
  const h = await s.provision(layers);
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  await s.startProcess(h, "sleep 3");
  await s.teardown(h);
  await store.update(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  const r = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(r.reaped, 0, "a live detached process keeps the box out of the reaper's hands");
  assert.equal(fake.current(scopeName())?.state, "running");
});

test("rotation aborts and keeps the old box when terminating it fails", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "still here\n");
  await s.teardown(a);
  await store.update(scope, { expiresAtMs: Date.now() + 3600_000 });
  fake.failTerminateOnce();
  const b = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1, "a failed terminate must not orphan a live box into a name conflict");
  assert.equal((await s.run(b, "cat keep.txt")).stdout, "still here\n");
  const c = await s.provision(layers);
  assert.equal(
    fake.createdCount(scopeName()),
    1,
    "the rotation hold keeps the scope on the old box instead of thrashing",
  );
  assert.equal(await s.readFile(c, "keep.txt"), "still here\n");
});

test("deep idle termination excludes writes from another core until recovery", { timeout: 10000 }, async () => {
  const advisoryLock = testAdvisoryLock();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = make({ advisoryLock });
  const second = make({ advisoryLock });
  const one = await first.provision(layers);
  const two = await second.provision(layers);
  await first.teardown(one);
  await store.update(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  fake.onSnapshot(async () => {
    entered.resolve();
    await release.promise;
  });
  const reaping = first.reapDeepIdle!(6 * 3600_000);
  await entered.promise;
  let completed = false;
  const writing = second.writeFile(two, "after-checkpoint.txt", "must survive").then(() => {
    completed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(completed, false);
  } finally {
    fake.onSnapshot(null);
    release.resolve();
    await Promise.all([reaping, writing]);
  }
  assert.equal(await second.readFile(two, "after-checkpoint.txt"), "must survive");
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("turn env reaches commands through the exec env parameter, never as inlined exports", async () => {
  const h = await sandbox.provision(layers, { env: { MY_TOKEN: "hunter2" } });
  const r = await sandbox.run(h, "echo TOKEN=$MY_TOKEN");
  assert.match(r.stdout, /TOKEN=hunter2/);
  assert.ok(!fake.execScripts().some((script) => script.includes("hunter2")));
});

test("scope and scratch sandboxes carry ownership tags", async () => {
  const h = await sandbox.provision(layers);
  assert.deepEqual(fake.tagsOf(fake.current(h.id)!.sandboxId), {
    "qm-org": tenant().orgId,
    "qm-prefix": "qmt",
    "qm-kind": "scope",
  });
  const scratch = await sandbox.provision(layers, { scratch: { key: "worker-1" } });
  const scratchIds: string[] = [];
  for await (const id of fake.client.listRunning!({ "qm-kind": "scratch" })) scratchIds.push(id);
  assert.equal(scratchIds.length, 1);
  assert.deepEqual(fake.tagsOf(scratchIds[0]!), { "qm-org": tenant().orgId, "qm-prefix": "qmt", "qm-kind": "scratch" });
  await sandbox.teardown(scratch);
});

test("forced scratch destruction surfaces failure and retries the same live session", async () => {
  const handle = await sandbox.provision(layers, { scratch: { key: "destroy-retry" } });
  fake.failTerminateOnce();
  await assert.rejects(sandbox.teardown(handle, { destroy: true }));
  assert.equal(fake.runningCount(), 1);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(fake.runningCount(), 0);
});

const nearExpiry = (): number => Date.now() + 3600_000;

test("a create race with another core instance adopts the winner instead of erroring", async () => {
  let missOnce = true;
  const racing: ModalClient = {
    ...fake.client,
    fromName: async (name) => {
      if (missOnce) {
        missOnce = false;
        return null;
      }
      return fake.client.fromName(name);
    },
  };
  await make({ store: testSandboxBodies(MODAL_BODIES) }).provision(layers);
  const s = make({ client: racing });
  const h = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.runningCount(), 1);
  assert.equal((await s.run(h, "echo raced")).stdout.trim(), "raced");
});

test("after a restart, rotating onto a name its stopping predecessor still holds waits for the name", async () => {
  const store = testSandboxBodies(MODAL_BODIES);
  const before = make({ store });
  const a = await before.provision(layers);
  await before.writeFile(a, "keep.txt", "survives the deploy\n");
  await before.teardown(a);
  await store.update(scope, { expiresAtMs: nearExpiry() });
  fake.holdNameAfterTerminate(2);
  const after = make({ store });
  const b = await after.provision(layers);
  assert.equal(await after.readFile(b, "keep.txt"), "survives the deploy\n");
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal(fake.runningCount(), 1);
});

test("teardown checkpoints the home and leaves the sandbox running", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.teardown(a);
  assert.equal(fake.current(a.id)?.state, "running", "no pause exists on modal — the warm path is staying up");
  assert.ok((await store.get(scope))?.checkpointId);
  const b = await s.provision(layers);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("destroy teardown terminates the sandbox", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.current(h.id), null);
});

test("a sandbox near Modal's lifetime is rotated at provision with files intact", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "survives rotation\n");
  await s.teardown(a);
  await store.update(scope, { expiresAtMs: nearExpiry() });
  const b = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2, "the stale box is replaced before modal's 24h wall kills it");
  assert.equal(b.coldStart, false);
  assert.equal(await s.readFile(b, "keep.txt"), "survives rotation\n");
  assert.equal(fake.runningCount(), 1, "the stale box was terminated, not leaked");
  assert.ok((await store.get(scope))!.expiresAtMs! > Date.now() + 23 * 3600_000);
});

test("teardown checkpoints are throttled by snapshotIntervalSec", async () => {
  const s = make({ snapshotIntervalSec: 3600 });
  await s.teardown(await s.provision(layers));
  await s.teardown(await s.provision(layers));
  assert.equal(fake.snapshotCount(), 1, "second teardown inside the interval skips the checkpoint");
});

test("reapDeepIdle checkpoints and terminates idle scopes, keeping the checkpoint reference", async () => {
  const s = make();
  const h = await s.provision(layers);
  await s.writeFile(h, "keep.txt", "parked\n");
  await s.teardown(h);
  await store.update(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  const r = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(r.reaped, 1, "the global cutoff is clamped to the six-hour default idle window");
  assert.equal(fake.current(scopeName()), null);
  assert.ok((await store.get(scope))?.checkpointId);
  const restarted = make();
  const b = await restarted.provision(layers);
  assert.equal(await restarted.readFile(b, "keep.txt"), "parked\n", "the reap checkpoint preserved the home");
});

test("idleParkSec sets the deep-idle window", async () => {
  const s = make({ idleParkSec: 60 });
  await s.teardown(await s.provision(layers));
  await store.update(scope, { lastActivityMs: Date.now() - 120_000 });
  assert.equal((await s.reapDeepIdle!(72 * 3600_000)).reaped, 1);
});

test("reapDeepIdle leaves recently active scopes alone and cleans rows for gone boxes without a checkpoint", async () => {
  const s = make();
  await s.provision(layers);
  const active = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(active.reaped, 0);
  assert.equal(fake.current(scopeName())?.state, "running");
  fake.terminate(scopeName());
  await store.update(scope, { checkpointId: undefined, lastActivityMs: Date.now() - 7 * 3600_000 });
  const gone = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(gone.reaped, 0);
  assert.equal(await store.get(scope), null, "a row whose box is already gone is cleaned up");
});

test("profile advertises provider checkpoints and process sessions", () => {
  assert.equal(sandbox.profile.backend, "modal");
  assert.equal(sandbox.profile.writablePersistence, "provider_managed");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
  assert.equal(make({ egressProxyUrl: "https://proxy.example.com" }).profile.egressEnforcement, "domain");
  assert.equal(make({ cpus: 4, memoryMb: 8192 }).profile.spec?.cpus, 4);
});

test("a failing checkpoint restore fails the provision instead of cold-starting empty", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  fake.terminate(a.id);
  fake.failRestoreOnce();
  await assert.rejects(() => s.provision(layers), /checkpoint restore failed/);
  assert.equal(fake.runningCount(), 0, "the failed replacement is terminated");
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "precious.txt"), "irreplaceable\n", "checkpoint survives the outage");
});

test("rotation aborts and keeps the old box when the pre-rotation checkpoint fails", async () => {
  const s = make();
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "must not vanish\n");
  await s.teardown(a);
  const checkpoint = (await store.get(scope))?.checkpointId;
  await store.update(scope, { expiresAtMs: nearExpiry() });
  fake.onSnapshot(async () => {
    throw new Error("provider checkpoint unavailable");
  });
  const b = await s.provision(layers);
  assert.equal(
    fake.createdCount(scopeName()),
    1,
    "a failed checkpoint must abort the rotation, never terminate the box",
  );
  assert.equal((await s.run(b, "cat keep.txt")).stdout, "must not vanish\n");
  assert.equal((await store.get(scope))?.checkpointId, checkpoint);
  assert.match((await store.get(scope))?.snapshotError ?? "", /unavailable/);
  fake.onSnapshot(null);
  const c = await make().provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2, "rotation resumes once checkpoints recover");
  assert.equal(await s.readFile(c, "keep.txt"), "must not vanish\n");
});

test("teardown of a box the turn never used skips the checkpoint only while the stored home is clean", async () => {
  const s = make();
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(fake.snapshotCount(), 1, "a home that was never checkpointed is saved even by an unused turn");
  await store.update(scope, { lastSnapshotMs: 1 });
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(fake.snapshotCount(), 1, "a clean home is not re-saved by an unused turn");
  fake.onSnapshot(async () => {
    throw new Error("down");
  });
  await s.teardown(await s.provision(layers));
  assert.equal((await store.get(scope))?.homeDirty, true, "a used turn whose checkpoint failed leaves the home dirty");
  fake.onSnapshot(null);
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal((await store.get(scope))?.homeDirty, false, "the next unused turn catches up the missed checkpoint");
});

test("checkpoints restore across core restarts and report their expiry", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "uncommitted.txt", "keep me");
  await first.teardown(handle);
  const record = (await store.get(scope))!;
  assert.ok(record.checkpointId);
  fake.terminate(scopeName());
  const restarted = make();
  const next = await restarted.provision(layers);
  assert.equal(await restarted.readFile(next, "uncommitted.txt"), "keep me");
  assert.ok(!fake.execScripts().some((script) => script.includes("tar --null")));
  const status = await restarted.computerStatus!(scope);
  assert.equal(status.recovery?.strategy, "provider_snapshot");
  assert.equal(status.recovery?.checkpointExpiresAtMs, record.checkpointAtMs! + MODAL_CHECKPOINT_RETENTION_MS);
  assert.ok(status.expiresAtMs);
});

test("rows written by the previous Modal record shape are migrated and keep their checkpoint", async () => {
  const seed = await fake.client.create({ name: "seed" });
  await seed.writeFileBytes("/root/workspace/legacy.txt", Buffer.from("old checkpoint"));
  const imageId = await seed.snapshotHome();
  await seed.terminate();
  const expiresAtMs = Date.now() + 20 * 24 * 3600_000;
  const url = testDatabaseUrl();
  const { q } = createPgPool(url);
  await q(`DROP TABLE IF EXISTS modal_sandbox_bodies`);
  await q(`DELETE FROM qm_schema_migrations WHERE id = $1`, [MODAL_BODIES.id]);
  await q(`CREATE TABLE modal_sandbox_bodies (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await q(`INSERT INTO modal_sandbox_bodies (id, json) VALUES ($1, $2)`, [
    scope,
    {
      sandboxId: "sb-retired",
      createdAtMs: 1,
      lastSnapshotMs: 2,
      nativeSnapshotId: imageId,
      nativeSnapshotExpiresAtMs: expiresAtMs,
      recoveryError: "earlier failure",
      snapshotGeneration: 3,
      lastSnapshotAttemptMs: 4,
      hydrationPending: false,
    },
  ]);
  const store = createSandboxBodies<StoredModalSandbox>(url, MODAL_BODIES);
  const upgraded = (await store.get(scope))! as StoredModalSandbox & Record<string, unknown>;
  assert.equal(upgraded.checkpointId, imageId);
  assert.equal(upgraded.checkpointAtMs, expiresAtMs - MODAL_CHECKPOINT_RETENTION_MS);
  assert.equal(upgraded.snapshotError, "earlier failure");
  assert.equal(upgraded.lastSnapshotMs, 2);
  assert.equal("initializationPending" in upgraded, false);
  for (const key of [
    "nativeSnapshotId",
    "nativeSnapshotExpiresAtMs",
    "recoveryError",
    "snapshotGeneration",
    "lastSnapshotAttemptMs",
    "hydrationPending",
  ])
    assert.equal(key in upgraded, false, key);
  const s = make({ store });
  const h = await s.provision(layers);
  assert.equal(await s.readFile(h, "legacy.txt"), "old checkpoint");
});

test("expired checkpoints block replacement instead of starting an empty home", async () => {
  const first = make();
  await first.teardown(await first.provision(layers));
  fake.terminate(scopeName());
  await store.update(scope, { checkpointAtMs: 1 });
  await assert.rejects(make().provision(layers), /checkpoint has expired/);
  assert.equal(fake.runningCount(), 0);
});

test("maintenance refreshes overdue checkpoints of active homes", async () => {
  const s = make();
  const handle = await s.provision(layers);
  await s.teardown(handle);
  const initial = (await store.get(scope))?.checkpointId;
  await store.update(scope, { lastSnapshotMs: 1 });
  await s.writeFile(handle, "background.txt", "new background output");
  await s.reapDeepIdle!(3600_000);
  assert.notEqual((await store.get(scope))?.checkpointId, initial);
  assert.equal(fake.current(scopeName())?.state, "running");
  fake.terminate(scopeName());
  const restarted = make();
  const recovered = await restarted.provision(layers);
  assert.equal(await restarted.readFile(recovered, "background.txt"), "new background output");
});

test("failed maintenance checkpoints wait for the interval", async () => {
  const s = make();
  await s.teardown(await s.provision(layers));
  await store.update(scope, { lastSnapshotMs: 1 });
  fake.onSnapshot(async () => {
    throw new Error("Timeout expired");
  });
  await s.reapDeepIdle!(3600_000);
  await s.reapDeepIdle!(3600_000);
  assert.equal(fake.snapshotCount(), 2);
  assert.equal((await store.get(scope))?.snapshotError, "Timeout expired");
  fake.onSnapshot(null);
});

test("maintenance checkpoints an idle scope with a live background job without reaping it", async () => {
  const s = make();
  const handle = await s.provision(layers);
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  await s.startProcess(handle, "sleep 5");
  await s.teardown(handle);
  const checkpoint = (await store.get(scope))?.checkpointId;
  await store.update(scope, { lastActivityMs: Date.now() - 7 * 3600_000, lastSnapshotMs: 1 });
  const result = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(result.reaped, 0);
  assert.equal(fake.current(scopeName())?.state, "running");
  assert.notEqual((await store.get(scope))?.checkpointId, checkpoint);
});

test("interrupted hydration is retried from the retained checkpoint on the next provision", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "working.txt", "last complete checkpoint");
  await first.teardown(handle);
  await first.writeFile(handle, "working.txt", "incomplete replacement content");
  await store.update(scope, { initializationPending: true });
  const restarted = make();
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "working.txt"), "last complete checkpoint");
  assert.equal((await store.get(scope))?.initializationPending, undefined);
});

test("restart checkpoints a healthy home, replaces the machine, and keeps the work", async () => {
  const s = make();
  const handle = await s.provision(layers);
  await s.writeFile(handle, "working.txt", "written after the last teardown");
  await s.restartComputer!(scope);
  assert.equal(fake.current(scopeName()), null);
  const next = await make().provision(layers);
  assert.equal(await s.readFile(next, "working.txt"), "written after the last teardown");
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("restart of interrupted hydration discards the replacement and retries the checkpoint", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "working.txt", "last complete checkpoint");
  await first.teardown(handle);
  const checkpoint = (await store.get(scope))!.checkpointId;
  await first.writeFile(handle, "working.txt", "incomplete replacement content");
  await store.update(scope, { initializationPending: true });
  const restarted = make();
  await restarted.restartComputer!(scope);
  assert.equal((await store.get(scope))!.checkpointId, checkpoint);
  assert.equal(fake.snapshotCount(), 1, "an incomplete home is never checkpointed");
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "working.txt"), "last complete checkpoint");
});

test("destroyScope terminates the machine and forgets the scope", async () => {
  const backend = make();
  const first = await backend.provision(layers);
  const firstId = (await store.get(scope))!.sandboxId;
  await backend.teardown(first);
  await backend.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.runningCount(), 0);
  const second = await backend.provision(layers);
  assert.notEqual((await store.get(scope))!.sandboxId, firstId);
  assert.equal(fake.createdCount(second.id), 2);
});

test("warm commands and process controls do not wait for a checkpoint", { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "keep.txt", "before checkpoint");
  fake.onSnapshot(async () => {
    entered.resolve();
    await release.promise;
  });
  const saving = sandbox.teardown(handle);
  try {
    await entered.promise;
    assert.equal((await sandbox.run(handle, "echo responsive")).stdout.trim(), "responsive");
    assert.equal(await sandbox.readFile(handle, "keep.txt"), "before checkpoint");
    assert.ok(supportsProcessSessions(sandbox));
    assert.deepEqual(await sandbox.listProcesses(handle), []);
  } finally {
    fake.onSnapshot(null);
    release.resolve();
    await saving;
  }
});

test("ordinary calls never rotate an aged warm sandbox", async () => {
  const s = make();
  const handle = await s.provision(layers);
  await store.update(scope, { expiresAtMs: nearExpiry() });
  const id = (await store.get(scope))!.sandboxId;
  await s.run(handle, "echo same machine");
  await s.writeFile(handle, "keep.txt", "same machine");
  assert.equal((await store.get(scope))!.sandboxId, id);
  assert.equal(fake.createdCount(scopeName()), 1);
  await s.provision(layers);
  assert.notEqual((await store.get(scope))!.sandboxId, id);
});

test("checkpoint writers from separate cores share the durable lifecycle lock", { timeout: 10000 }, async () => {
  const advisoryLock = testAdvisoryLock();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writers = 0;
  let maximum = 0;
  const first = make({ advisoryLock, snapshotIntervalSec: 0 });
  const second = make({ advisoryLock, snapshotIntervalSec: 0 });
  const a = await first.provision(layers);
  const b = await second.provision(layers);
  fake.onSnapshot(async () => {
    writers++;
    maximum = Math.max(maximum, writers);
    if (fake.snapshotCount() === 1) {
      entered.resolve();
      await release.promise;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    writers--;
  });
  const saving = first.teardown(a);
  await entered.promise;
  assert.equal((await second.run(b, "echo second core")).stdout.trim(), "second core");
  const exporting = second.teardown(b);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    release.resolve();
    await Promise.all([saving, exporting]);
    fake.onSnapshot(null);
  }
  assert.equal(maximum, 1);
  assert.equal(fake.snapshotCount(), 2);
});

test("a near-expiry checkpoint of a reaped scope is renewed before Modal deletes it", async () => {
  const s = make();
  const handle = await s.provision(layers);
  await s.writeFile(handle, "work.txt", "idle for a month");
  await store.update(scope, { lastActivityMs: 1 });
  assert.equal((await s.reapDeepIdle!(1)).reaped, 1);
  const parked = (await store.get(scope))!;
  assert.ok(parked.checkpointId);
  const day = 24 * 3600_000;
  await store.update(scope, { checkpointAtMs: Date.now() - 10 * day });
  await s.reapDeepIdle!(1);
  assert.equal((await store.get(scope))!.checkpointId, parked.checkpointId, "far from expiry: untouched");
  await store.update(scope, { checkpointAtMs: Date.now() - 29 * day });
  await s.reapDeepIdle!(1);
  const renewed = (await store.get(scope))!;
  assert.notEqual(renewed.checkpointId, parked.checkpointId);
  assert.ok(renewed.checkpointAtMs! > Date.now() - 60_000);
  assert.equal(renewed.lastActivityMs, 1, "renewal is maintenance, not user activity");
  assert.equal(renewed.initializationPending, undefined);
  assert.equal(fake.current(scopeName()), null, "the renewal sandbox is terminated again");
  assert.equal(fake.runningCount(), 0);
  const restarted = make();
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "work.txt"), "idle for a month");
});

test("checkpoint renewal skips expired checkpoints instead of looping", async () => {
  const s = make();
  await s.provision(layers);
  await store.update(scope, { lastActivityMs: 1 });
  await s.reapDeepIdle!(1);
  const parked = (await store.get(scope))!;
  await store.update(scope, { checkpointAtMs: 1 });
  await s.reapDeepIdle!(1);
  assert.equal((await store.get(scope))!.checkpointId, parked.checkpointId, "expired: nothing to renew");
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("a sandbox approaching Modal's lifetime limit is checkpointed and retired even while busy", async () => {
  const s = make();
  const handle = await s.provision(layers);
  await s.writeFile(handle, "job.txt", "in flight");
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  await s.startProcess(handle, "sleep 30");
  assert.equal((await s.reapDeepIdle!(72 * 3600_000)).reaped, 0, "a fresh busy sandbox is left alone");
  await store.update(scope, { expiresAtMs: Date.now() + 60_000 });
  assert.equal((await s.reapDeepIdle!(72 * 3600_000)).reaped, 1);
  assert.equal(fake.current(scopeName()), null);
  assert.ok((await store.get(scope))!.checkpointId);
  const next = await s.provision(layers);
  assert.equal(await s.readFile(next, "job.txt"), "in flight");
  assert.ok((await store.get(scope))!.expiresAtMs! > Date.now() + 23 * 3600_000);
});

test("untracked scope sandboxes are terminated after a grace period while scratch and other deployments are kept", async () => {
  const s = make();
  const handle = await s.provision(layers);
  const tracked = fake.current(handle.id)!.sandboxId;
  const orphan = fake.createUntracked({ "qm-org": tenant().orgId, "qm-prefix": "qmt", "qm-kind": "scope" });
  const scratch = fake.createUntracked({ "qm-org": tenant().orgId, "qm-prefix": "qmt", "qm-kind": "scratch" });
  const foreign = fake.createUntracked({ "qm-org": tenant().orgId, "qm-prefix": "other", "qm-kind": "scope" });
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    assert.equal((await s.reapDeepIdle!(72 * 3600_000)).reaped, 0, "first sighting starts the grace period");
    assert.equal(fake.runningCount(), 4);
    mock.timers.tick(11 * 60_000);
    assert.equal((await s.reapDeepIdle!(72 * 3600_000)).reaped, 1);
  } finally {
    mock.timers.reset();
  }
  const running = new Set<string>();
  for await (const id of fake.client.listRunning!({})) running.add(id);
  assert.deepEqual(running, new Set([tracked, scratch, foreign]));
  assert.equal(running.has(orphan), false);
});
