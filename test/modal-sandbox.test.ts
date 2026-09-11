import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModalSandbox, type StoredModalSandbox } from "../src/sandbox/modal-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { instrumentedSnapshotStore } from "./support/snapshot-stores.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeModal, type FakeModal } from "./support/fake-modal.ts";
import { ModalSandboxGoneError, type ModalClient } from "../src/sandbox/modal-client.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeModal;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createModalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "modal-ws-"))), {
    client: fake.client,
    namePrefix: "qmt",
    nativeSnapshotsEnabled: true,
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeModal();
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

test("an already-aborted signal never executes a command", async () => {
  const handle = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  const signal = AbortSignal.abort();
  await assert.rejects(sandbox.run(handle, "echo must-not-run", { signal }), /aborted/i);
  assert.equal(fake.execScripts().length, before);
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

test("listDir and removeDir", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "d/one.txt", "1");
  await sandbox.writeFile(h, "d/e/two.txt", "2");
  const listed = await sandbox.listDir(h, "d");
  assert.deepEqual(listed.sort(), ["d/e/two.txt", "d/one.txt"]);
  await sandbox.removeDir(h, "d");
  assert.equal(await sandbox.readFile(h, "d/one.txt"), null);
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

test("large command output survives intact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "python3 -c \"print('x' * (900 * 1024), end='')\"");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "x".repeat(900 * 1024));
});

test("sandbox is reused across provisions and warm start is reported", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("an existing live sandbox holding the scope name is adopted after a restart", async () => {
  await make().provision(layers);
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
});

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
  await make().provision(layers);
  const s = createModalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "modal-ws-"))), {
    client: racing,
    namePrefix: "qmt",
  });
  const h = await s.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  const r = await s.run(h, "echo raced");
  assert.equal(r.stdout.trim(), "raced");
});

test("the durable store reconnects the same sandbox across backend instances", async () => {
  const store: DurableMap<StoredModalSandbox> = createMemoryMap();
  const s1 = make({ store });
  const a = await s1.provision(layers);
  await s1.writeFile(a, "keep.txt", "resident\n");
  const first = fake.current(a.id)?.sandboxId;
  const s2 = make({ store });
  const b = await s2.provision(layers);
  assert.equal(fake.current(b.id)?.sandboxId, first);
  assert.equal(await s2.readFile(b, "keep.txt"), "resident\n");
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("scratch sandboxes are unnamed, ephemeral, and terminated at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.createdCount(scopeName()), 0, "a scratch box must not claim the scope name");
  assert.equal(fake.runningCount(), 1);
  await sandbox.teardown(h);
  assert.equal(fake.runningCount(), 0);
});

test("teardown snapshots the home and leaves the sandbox running", async () => {
  const counting = instrumentedSnapshotStore();
  const s = make({ snapshots: counting.store });
  const a = await s.provision(layers);
  await s.teardown(a);
  assert.equal(fake.current(a.id)?.state, "running", "no pause exists on modal — the warm path is staying up");
  assert.equal(counting.puts(), 1);
  const b = await s.provision(layers);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("destroy teardown terminates the sandbox and forgets the scope", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const h = await s.provision(layers);
  await s.teardown(h, { destroy: true });
  assert.equal(fake.current(h.id), null);
  assert.equal(await store.get(scope), null);
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

test("a sandbox that dies mid-turn is revived transparently for the next command", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.terminate(h.id);
  const r = await sandbox.run(h, "echo back");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "back");
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("a sandbox older than rotateAfterMs is rotated at provision with files intact", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "survives rotation\n");
  await s.teardown(a);
  await store.merge(scope, { createdAtMs: Date.now() - 21 * 3600_000 });
  const b = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2, "the stale box is replaced before modal's 24h wall kills it");
  assert.equal(b.coldStart, false);
  assert.equal(await s.readFile(b, "keep.txt"), "survives rotation\n");
  assert.equal(fake.runningCount(), 1, "the stale box was terminated, not leaked");
});

test("rotation snapshots changes written since the last teardown snapshot", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const a = await s.provision(layers);
  await s.teardown(a);
  await s.writeFile(a, "late.txt", "written after teardown\n");
  await store.merge(scope, { createdAtMs: Date.now() - 21 * 3600_000 });
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "late.txt"), "written after teardown\n");
});

test("teardown snapshots are throttled by snapshotIntervalMs", async () => {
  const counting = instrumentedSnapshotStore();
  const s = make({ snapshots: counting.store, snapshotIntervalMs: 60 * 60_000 });
  const a = await s.provision(layers);
  await s.teardown(a);
  const b = await s.provision(layers);
  await s.teardown(b);
  assert.equal(counting.puts(), 1, "second teardown inside the interval skips the snapshot");
});

test("reapDeepIdle snapshots, terminates, and forgets idle scopes", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const h = await s.provision(layers);
  await s.writeFile(h, "keep.txt", "parked\n");
  await s.teardown(h);
  await store.merge(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  const r = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(
    r.reaped,
    1,
    "the driver clamps the global cutoff to its own reapIdleMs — 3 idle days never accrue on a per-second-billed box",
  );
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "keep.txt"), "parked\n", "the reap snapshot preserved the home");
});

test("reapDeepIdle leaves recently active scopes alone and cleans rows for already-gone boxes", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const h = await s.provision(layers);
  await s.teardown(h);
  const active = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(active.reaped, 0);
  assert.equal(fake.current(scopeName())?.state, "running");
  fake.terminate(scopeName());
  await store.merge(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  const gone = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(gone.reaped, 0);
  assert.equal(await store.get(scope), null, "a row whose box is already gone is cleaned up");
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

test("profile advertises snapshot persistence and process sessions", () => {
  assert.equal(sandbox.profile.backend, "modal");
  assert.equal(sandbox.profile.writablePersistence, "snapshot_to_workspace");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
});

test("file reads and writes revive a sandbox that died mid-turn", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "pre.txt", "before death\n");
  await sandbox.teardown(h);
  fake.terminate(h.id);
  const h2 = await sandbox.provision(layers);
  fake.terminate(h2.id);
  await sandbox.writeFile(h2, "post.txt", "after revival\n");
  assert.equal(await sandbox.readFile(h2, "post.txt"), "after revival\n");
  assert.equal(await sandbox.readFile(h2, "pre.txt"), "before death\n");
  assert.equal(await sandbox.readFile(h2, "never-existed.txt"), null);
});

test("computerStatus never provisions a sandbox", async () => {
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.guestResponsive, false);
  assert.equal(status.provisioned, false);
  assert.match(status.machine, /no sandbox provisioned yet/);
  assert.equal(fake.totalCreated(), 0, "a status probe must not create a sandbox");
});

test("a scratch sandbox that dies mid-turn is revived as scratch, not as a durable scope sandbox", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-revive" } });
  fake.terminateAllRunning();
  const r = await sandbox.run(h, "echo scratch-back");
  assert.equal(r.stdout.trim(), "scratch-back");
  assert.equal(fake.createdCount(scopeName()), 0, "the revived box must not claim the scope name");
  assert.equal(fake.totalCreated(), 2);
});

test("a failing snapshot store fails the fallback provision instead of cold-starting empty", async () => {
  const flaky = instrumentedSnapshotStore();
  const s = make({ snapshots: flaky.store });
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  fake.terminate(a.id);
  flaky.failReads(true);
  await assert.rejects(() => s.provision(layers), /hydration failed/);
  flaky.failReads(false);
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "precious.txt"), "irreplaceable\n", "snapshot survives the outage");
});

test("blob staging is advertised only when the channel is actually wired", async () => {
  assert.equal(
    supportsBlobStaging(make()),
    false,
    "without blobTransfer/secret/apiBaseUrl the capability must not be claimed — copyHome probes for it",
  );
  const wired = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  assert.equal(supportsBlobStaging(wired), true, "wired up, modal can move bytes by reference");
});

test("stageOut posts to core's blob endpoint by streaming, never by buffering in the guest", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageOut!(h, "outbox/big.bin"), /modal stageOut/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs"))!;
  assert.ok(script, "the stageOut curl reached the guest");
  assert.match(script, /--upload-file/, "streams from disk rather than buffering in the guest");
  assert.doesNotMatch(script, /--data-binary/, "the OOM shape must never come back");
  assert.match(script, /-X POST/, "--upload-file alone would send PUT");
  assert.match(script, /x-content-sha256/, "core verifies the upload end-to-end");
});

test("stageIn pulls a blob into the guest atomically (temp then mv)", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageIn!(h, "inbox/big.bin", "f".repeat(32)), /modal stageIn/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs/"))!;
  assert.match(script, /-o .*\.part/, "downloads to a temp file");
  assert.match(script, /mv -f /, "and only then moves it into place");
  assert.match(script, /curl -fsS/, "-f so an HTTP error fails loudly instead of writing the error body");
});

test("adoptHomeSnapshot promotes a staged blob to the snapshot store and resets the scope's sandbox", async () => {
  const { Readable } = await import("node:stream");
  const { makeTar } = await import("../src/sandbox/tar.ts");
  const blobs = createMemoryBlobTransferStore();
  const s = make({ blobTransfer: blobs, capabilitySecret: "blob-secret", apiBaseUrl: "http://core.internal:8080" });

  const a = await s.provision(layers);
  await s.writeFile(a, "old.txt", "stale e2b-era sandbox\n");
  await s.teardown(a, { keepWarm: true });

  const tar = await makeTar([{ path: "migrated.txt", data: Buffer.from("came from e2b\n") }]);
  const { blobId } = await blobs.put(Readable.from([Buffer.from(tar)]));
  assert.ok(s.adoptHomeSnapshot);
  await s.adoptHomeSnapshot!(scope, blobId);

  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "../migrated.txt"), "came from e2b\n", "hydrates from the adopted snapshot");
  assert.equal(await s.readFile(b, "../old.txt"), null, "the pre-adopt sandbox was discarded, not reused");
});

test("persistHomeSnapshot writes the live home to the snapshot store on demand", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const counting = instrumentedSnapshotStore();
  const s = make({ store, snapshots: counting.store, snapshotIntervalMs: 60 * 60_000 });
  const h = await s.provision(layers);
  await s.writeFile(h, "keep.txt", "persist me\n");
  assert.ok(s.persistHomeSnapshot);
  await s.persistHomeSnapshot!(scope);
  assert.equal(counting.puts(), 1, "persists immediately, ignoring the teardown throttle");
});

test("rotation aborts and keeps the old box when the pre-rotation snapshot fails", async () => {
  const flaky = instrumentedSnapshotStore();
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store, snapshots: flaky.store, rotationHoldMs: 0 });
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "must not vanish\n");
  await s.teardown(a);
  await store.merge(scope, { createdAtMs: Date.now() - 21 * 3600_000 });
  flaky.failWrites(true);
  const b = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1, "a failed snapshot must abort the rotation, never terminate the box");
  assert.equal((await s.run(b, "cat keep.txt")).stdout, "must not vanish\n");
  flaky.failWrites(false);
  const c = await s.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2, "rotation resumes once the snapshot store recovers");
  assert.equal(await s.readFile(c, "keep.txt"), "must not vanish\n");
});

test("reapDeepIdle spares a box running a detached background job", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const h = await s.provision(layers);
  assert.ok(supportsProcessSessions(s));
  if (!supportsProcessSessions(s)) return;
  await s.startProcess(h, "sleep 3");
  await s.teardown(h);
  await store.merge(scope, { lastActivityMs: Date.now() - 7 * 3600_000 });
  const r = await s.reapDeepIdle!(72 * 3600_000);
  assert.equal(r.reaped, 0, "a live detached process keeps the box out of the reaper's hands");
  assert.equal(fake.current(scopeName())?.state, "running");
});

test("unhydrated named homes are refused before adoption and never overwrite checkpoints", async () => {
  await fake.client.create({ name: scopeName() });
  const counting = instrumentedSnapshotStore();
  const s = make({ snapshots: counting.store });
  await assert.rejects(s.provision(layers), /never finished hydrating/);
  assert.equal(counting.puts(), 0);
  assert.equal(fake.current(scopeName())?.state, "running");
});

test("rotation aborts and keeps the old box when terminating it fails", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store });
  const a = await s.provision(layers);
  await s.writeFile(a, "keep.txt", "still here\n");
  await s.teardown(a);
  await store.merge(scope, { createdAtMs: Date.now() - 21 * 3600_000 });
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

test("homes larger than the file chunk size snapshot and hydrate through chunked transfers", async () => {
  const s = make({ fileChunkBytes: 8 * 1024 });
  const h = await s.provision(layers);
  const big = Buffer.alloc(50 * 1024 + 7);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
  await s.writeFileBytes(h, "../big.bin", big);
  await s.teardown(h);
  fake.terminate(h.id);
  const b = await s.provision(layers);
  const back = await s.readFileBytes(b, "../big.bin");
  assert.ok(back && Buffer.from(back).equals(big), "chunked snapshot + hydrate round-trips the exact bytes");
});

test("teardown of a box the turn never used skips the snapshot only while the stored home is clean", async () => {
  const counting = instrumentedSnapshotStore();
  const store = createMemoryMap<StoredModalSandbox>();
  const s = make({ store, snapshots: counting.store });
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(counting.puts(), 1, "a home that was never snapshotted is saved even by an unused turn");
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(counting.puts(), 1, "a clean home is not re-saved by an unused turn");
  counting.failWrites(true);
  await s.teardown(await s.provision(layers));
  assert.equal(counting.puts(), 1);
  assert.equal((await store.get(scope))?.homeDirty, true, "a used turn whose snapshot failed leaves the home dirty");
  counting.failWrites(false);
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(counting.puts(), 2, "the next unused turn catches up the missed snapshot");
  assert.equal((await store.get(scope))?.homeDirty, false);
});

test("native checkpoints restore across rotation and core restarts without transferring a tar", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const portable = instrumentedSnapshotStore();
  const first = make({ store, snapshots: portable.store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "uncommitted.txt", "keep me");
  await first.teardown(handle);
  const checkpoint = (await store.get(scope))?.nativeSnapshotId;
  assert.ok(checkpoint);
  assert.equal(portable.puts(), 0);
  await store.merge(scope, { createdAtMs: 0 });
  const restarted = make({ store, snapshots: portable.store });
  const next = await restarted.provision(layers);
  assert.equal(await restarted.readFile(next, "uncommitted.txt"), "keep me");
  assert.equal(portable.puts(), 0);
  assert.ok(!fake.execScripts().some((script) => script.includes("tar --null")));
  const status = await restarted.computerStatus!(scope);
  assert.equal(status.recovery?.strategy, "provider_snapshot");
  assert.ok(status.recovery?.checkpointExpiresAtMs);
});

test("native checkpoint references survive deep-idle reaping", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "work.txt", "durable checkpoint");
  await store.merge(scope, { lastActivityMs: 1 });
  assert.equal((await first.reapDeepIdle!(1)).reaped, 1);
  assert.ok((await store.get(scope))?.nativeSnapshotId);
  const restarted = make({ store });
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "work.txt"), "durable checkpoint");
});

test("expired native checkpoints block replacement without falling back to stale portable data", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  fake.terminate(scopeName());
  await store.merge(scope, { nativeSnapshotExpiresAtMs: 1 });
  const restarted = make({ store });
  await assert.rejects(restarted.provision(layers), /checkpoint has expired/);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.match((await store.get(scope))?.recoveryError ?? "", /expired/);
});

test("native checkpoint failure preserves the previous reference and keeps the source running", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  let fail = false;
  const wrapped: ModalClient = {
    ...fake.client,
    async create(options) {
      const session = await fake.client.create(options);
      return {
        ...session,
        async snapshotHome() {
          if (fail) throw new Error("provider checkpoint unavailable");
          return session.snapshotHome!();
        },
      };
    },
  };
  const first = make({ store, client: wrapped, rotationHoldMs: 0 });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  const checkpoint = (await store.get(scope))?.nativeSnapshotId;
  fail = true;
  await store.merge(scope, { createdAtMs: 0 });
  await first.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal((await store.get(scope))?.nativeSnapshotId, checkpoint);
  assert.match((await store.get(scope))?.recoveryError ?? "", /unavailable/);
});

test("native scheduling ignores disabled legacy tar intervals and refreshes active homes in maintenance", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store, client: { ...fake.client, nativeSnapshots: true }, snapshotIntervalMs: 1e15 });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  const initial = (await store.get(scope))?.nativeSnapshotId;
  assert.ok(initial);
  await store.merge(scope, { lastSnapshotMs: 1 });
  await first.writeFile(handle, "background.txt", "new background output");
  await first.reapDeepIdle!(3600_000);
  assert.notEqual((await store.get(scope))?.nativeSnapshotId, initial);
  fake.terminate(scopeName());
  const restarted = make({ store });
  const recovered = await restarted.provision(layers);
  assert.equal(await restarted.readFile(recovered, "background.txt"), "new background output");
});

test("a late checkpoint from another core cannot replace a newer committed checkpoint", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const wrap = (session: Awaited<ReturnType<ModalClient["create"]>>) => ({
    ...session,
    async snapshotHome() {
      const snapshot = await session.snapshotHome!();
      if (++calls === 1) {
        started();
        await wait;
      }
      return snapshot;
    },
  });
  const client: ModalClient = {
    ...fake.client,
    create: async (options) => wrap(await fake.client.create(options)),
    fromId: async (id) => wrap(await fake.client.fromId(id)),
  };
  const first = make({ store, client });
  const second = make({ store, client });
  const one = await first.provision(layers);
  const two = await second.provision(layers);
  const older = first.teardown(one);
  await entered;
  await second.teardown(two);
  const newest = (await store.get(scope))?.nativeSnapshotId;
  release();
  await older;
  assert.equal((await store.get(scope))?.nativeSnapshotId, newest);
  assert.equal((await store.get(scope))?.snapshotGeneration, 2);
});

test("maintenance checkpoints an idle scope with a live background job without reaping it", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store, client: { ...fake.client, nativeSnapshots: true } });
  const handle = await first.provision(layers);
  assert.ok(supportsProcessSessions(first));
  if (!supportsProcessSessions(first)) return;
  await first.startProcess(handle, "sleep 5");
  await first.teardown(handle);
  const checkpoint = (await store.get(scope))?.nativeSnapshotId;
  await first.writeFile(handle, "background.txt", "new output");
  await store.merge(scope, { lastActivityMs: Date.now() - 7 * 3600_000, lastSnapshotMs: 1 });
  const result = await first.reapDeepIdle!(72 * 3600_000);
  assert.equal(result.reaped, 0);
  assert.equal(fake.current(scopeName())?.state, "running");
  assert.notEqual((await store.get(scope))?.nativeSnapshotId, checkpoint);
});

test("native capture requires activation and adopted native scopes remain native after flag rollback", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const portable = instrumentedSnapshotStore();
  const first = make({ store, snapshots: portable.store, nativeSnapshotsEnabled: undefined });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "working.txt", "portable generation");
  await first.teardown(handle);
  assert.equal((await store.get(scope))?.nativeSnapshotId, undefined);
  assert.equal(portable.puts(), 1);

  const activated = make({ store, snapshots: portable.store, nativeSnapshotsEnabled: true });
  const active = await activated.provision(layers);
  await activated.writeFile(active, "working.txt", "native generation");
  await store.merge(scope, { lastSnapshotMs: 0 });
  await activated.teardown(active);
  assert.ok((await store.get(scope))?.nativeSnapshotId);
  assert.equal(portable.puts(), 1);
  fake.terminate(scopeName());

  const rollback = make({ store, snapshots: portable.store, nativeSnapshotsEnabled: false });
  const recovered = await rollback.provision(layers);
  assert.equal(await rollback.readFile(recovered, "working.txt"), "native generation");
  await rollback.writeFile(recovered, "working.txt", "reader rollback generation");
  await store.merge(scope, { lastSnapshotMs: 0 });
  await rollback.teardown(recovered);
  assert.equal(portable.puts(), 1);
  fake.terminate(scopeName());
  const restarted = make({ store, snapshots: portable.store, nativeSnapshotsEnabled: false });
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "working.txt"), "reader rollback generation");
});

test("interrupted hydration cannot expose a partially restored home through stored adoption", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "working.txt", "do not overwrite");
  await store.merge(scope, { hydrationPending: true });
  const restarted = make({ store });
  await assert.rejects(restarted.provision(layers), /hydration was interrupted/);
  assert.equal(fake.createdCount(scopeName()), 1);
  const status = await restarted.computerStatus!(scope);
  assert.match(status.recovery?.error ?? "", /computer restart/);
  assert.equal((await store.get(scope))?.hydrationPending, true);
});

test("explicit restart of interrupted hydration retains the checkpoint and retries it", async () => {
  fake.cleanup();
  fake = installFakeModal({ native: true });
  const store = createMemoryMap<StoredModalSandbox>();
  const first = make({ store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "working.txt", "last complete checkpoint");
  await first.teardown(handle);
  const checkpoint = (await store.get(scope))!.nativeSnapshotId;
  await first.writeFile(handle, "working.txt", "incomplete replacement content");
  await store.merge(scope, { hydrationPending: true });
  const restarted = make({ store, nativeSnapshotsEnabled: false });
  await restarted.restartComputer!(scope);
  assert.equal((await store.get(scope))!.nativeSnapshotId, checkpoint);
  const restored = await restarted.provision(layers);
  assert.equal(await restarted.readFile(restored, "working.txt"), "last complete checkpoint");
});

for (const path of ["stored", "name-conflict"] as const) {
  test(`unhydrated homes cannot enter through ${path} adoption`, async () => {
    const session = await fake.client.create({ name: scopeName() });
    const store = createMemoryMap<StoredModalSandbox>();
    if (path === "stored") await store.put(scope, { sandboxId: session.sandboxId, createdAtMs: Date.now() });
    let first = true;
    const client = {
      ...fake.client,
      async fromName(name: string) {
        if (path === "name-conflict" && first) {
          first = false;
          return null;
        }
        return fake.client.fromName(name);
      },
    };
    const backend = make({ store, client });
    await assert.rejects(backend.provision(layers), /never finished hydrating/);
    assert.equal(fake.current(scopeName())?.state, "running");
    assert.equal(fake.createdCount(scopeName()), 1);
  });
}

test("destroyScope deletes expired native state without provisioning and retains metadata on failure", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const record: StoredModalSandbox = {
    sandboxId: "expired-machine",
    createdAtMs: 0,
    nativeSnapshotId: "expired-checkpoint",
    nativeSnapshotExpiresAtMs: 1,
    hydrationPending: true,
  };
  await store.put(scope, record);
  const deleted: string[] = [];
  let fail = true;
  const backend = make({
    store,
    client: {
      ...fake.client,
      async create() {
        throw new Error("must not provision");
      },
      async fromId() {
        throw new Error("must not reconnect");
      },
      async fromName() {
        throw new Error("must not discover");
      },
      async terminate(id: string) {
        deleted.push(id);
        if (fail) throw new Error("provider temporarily unavailable");
        throw new ModalSandboxGoneError(id, "already gone");
      },
    },
  });
  await assert.rejects(backend.destroyScope!(scope), /temporarily unavailable/);
  assert.deepEqual(await store.get(scope), record);
  fail = false;
  await backend.destroyScope!(scope);
  await backend.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.deepEqual(deleted, ["expired-machine", "expired-machine"]);
});

test("destroyScope clears a live Modal session cache after deleting its stored machine", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const backend = make({ store });
  const first = await backend.provision(layers);
  const firstId = (await store.get(scope))!.sandboxId;
  await backend.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  const second = await backend.provision(layers);
  assert.equal(second.coldStart, true);
  assert.notEqual((await store.get(scope))!.sandboxId, firstId);
  assert.equal(fake.createdCount(first.id), 2);
});

test("repeated destroy teardown never targets an unrelated default scope", async () => {
  const store = createMemoryMap<StoredModalSandbox>();
  const backend = make({ store });
  await backend.provision([]);
  const defaultRecord = await store.get("default");
  assert.ok(defaultRecord);
  const handle = await backend.provision(layers);
  await backend.teardown(handle, { destroy: true });
  await backend.teardown(handle, { destroy: true });
  assert.deepEqual(await store.get("default"), defaultRecord);
  assert.equal(await store.get(scope), null);
});
