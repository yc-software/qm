import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2bSandbox, type StoredE2bSandbox } from "../src/sandbox/e2b-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { instrumentedSnapshotStore } from "./support/snapshot-stores.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../src/auth/capability-token.ts";
import { installFakeE2b, type FakeE2b } from "./support/fake-e2b.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { E2bSandboxGoneError } from "../src/sandbox/e2b-client.ts";

let fake: FakeE2b;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createE2bSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "e2b-ws-"))), {
    client: fake.client,
    namePrefix: "qmt",
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeE2b();
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

test("an existing live sandbox tagged with the scope name is adopted after a restart", async () => {
  await fake.client.create({ metadata: { name: scopeName() }, autoPause: true });
  const h = await sandbox.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  const r = await sandbox.run(h, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
});

test("the durable store reconnects the same sandbox across backend instances", async () => {
  const store: DurableMap<StoredE2bSandbox> = createMemoryMap();
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

test("exec on a paused sandbox auto-resumes", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  fake.pause(h.id);
  const r = await sandbox.run(h, "cat keep.txt");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "still here\n");
  assert.equal(fake.current(h.id)?.state, "running");
});

test("scratch sandboxes are ephemeral and killed at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.equal(fake.current(h.id)?.metadata.scratch, "true");
  await sandbox.teardown(h);
  assert.equal(fake.current(h.id), null);
});

test("teardown pauses the sandbox; destroy kills it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  assert.equal(fake.current(h.id)?.state, "paused");
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.current(h.id), null);
});

test("keepWarm teardown leaves the sandbox running for background work", async () => {
  const a = await sandbox.provision(layers);
  await sandbox.writeFile(a, "keep.txt", "resident\n");
  await sandbox.teardown(a, { keepWarm: true });
  assert.equal(fake.current(a.id)?.state, "running");
  const b = await sandbox.provision(layers);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await sandbox.readFile(b, "keep.txt"), "resident\n");
});

test("expired pause falls back to a fresh sandbox with home hydrated from the snapshot", async () => {
  const a = await sandbox.provision(layers);
  await sandbox.writeFile(a, "keep.txt", "survives expiry\n");
  await sandbox.teardown(a);
  fake.expirePaused();
  const b = await sandbox.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal(await sandbox.readFile(b, "keep.txt"), "survives expiry\n");
  const r = await sandbox.run(b, "echo revived");
  assert.equal(r.stdout.trim(), "revived");
});

test("a sandbox that dies mid-turn is revived transparently for the next command", async () => {
  const h = await sandbox.provision(layers);
  fake.pause(h.id);
  fake.expirePaused();
  const r = await sandbox.run(h, "echo back");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "back");
  assert.equal(fake.createdCount(scopeName()), 2);
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

test("computerStatus probes the guest", async () => {
  await sandbox.provision(layers);
  assert.ok(sandbox.computerStatus);
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.guestResponsive, true);
  assert.equal(status.provisioned, true);
  assert.match(status.machine, /e2b sandbox sbx-/);
});

test("computerStatus reports a gone sandbox as unprovisioned, not wedged", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.expirePaused();
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.guestResponsive, false);
  assert.equal(status.provisioned, false, "a sandbox the platform says is gone needs a re-provision, not a restart");
});

test("profile advertises snapshot persistence and process sessions", () => {
  assert.equal(sandbox.profile.backend, "e2b");
  assert.equal(sandbox.profile.writablePersistence, "snapshot_to_workspace");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
});

test("file reads and writes revive a sandbox that died mid-turn", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "pre.txt", "before death\n");
  await sandbox.teardown(h);
  fake.expirePaused();

  const h2 = await sandbox.provision(layers);
  fake.pause(h2.id);
  fake.expirePaused();
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
  assert.equal(fake.createdCount(scopeName()), 0, "a status probe must not create a sandbox");
});

test("a scratch sandbox that dies mid-turn is revived as scratch, not as a durable scope sandbox", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-revive" } });
  fake.pause(h.id);
  fake.expirePaused();
  const r = await sandbox.run(h, "echo scratch-back");
  assert.equal(r.stdout.trim(), "scratch-back");
  const cur = fake.current(h.id);
  assert.equal(cur?.metadata.scratch, "true", "revived sandbox must still be tagged scratch");
});

test("a failing snapshot store fails the fallback provision instead of cold-starting empty", async () => {
  const flaky = instrumentedSnapshotStore();
  const s = make({ snapshots: flaky.store });
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  fake.expirePaused();
  flaky.failReads(true);
  await assert.rejects(() => s.provision(layers), /hydration failed/);
  flaky.failReads(false);
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "precious.txt"), "irreplaceable\n", "snapshot survives the outage");
});

test("adoptHomeSnapshot promotes a staged blob to the snapshot store and resets the scope's sandbox", async () => {
  const { makeTar } = await import("../src/sandbox/tar.ts");
  const blobs = createMemoryBlobTransferStore();
  const s = make({ blobTransfer: blobs, capabilitySecret: "blob-secret", apiBaseUrl: "http://core.internal:8080" });

  const a = await s.provision(layers);
  await s.writeFile(a, "old.txt", "stale sprite-era sandbox\n");
  await s.teardown(a, { keepWarm: true });

  const tar = await makeTar([{ path: "migrated.txt", data: Buffer.from("came from sprites\n") }]);
  const { blobId } = await blobs.put(Readable.from([Buffer.from(tar)]));
  assert.ok(s.adoptHomeSnapshot);
  await s.adoptHomeSnapshot!(scope, blobId);

  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "../migrated.txt"), "came from sprites\n", "hydrates from the adopted snapshot");
  assert.equal(await s.readFile(b, "../old.txt"), null, "the pre-adopt sandbox was discarded, not reused");
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
  assert.equal(supportsBlobStaging(wired), true, "wired up, e2b can move bytes by reference");
});

test("stageOut posts to core's blob endpoint by streaming, never by buffering in the guest", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    capabilitySecret: "blob-secret",
    apiBaseUrl: "http://core.internal:8080",
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageOut!(h, "artifacts/big.bin"), /e2b stageOut/);

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
  await assert.rejects(() => sb.stageIn!(h, "inbox/big.bin", "f".repeat(32)), /e2b stageIn/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs/"))!;
  assert.match(script, /-o .*\.part/, "downloads to a temp file");
  assert.match(script, /mv -f /, "and only then moves it into place");
  assert.match(script, /curl -fsS/, "-f so an HTTP error fails loudly instead of writing the error body");
});

test("native pause skips tar checkpoints and status does not wake a paused sandbox", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const portable = instrumentedSnapshotStore();
  const client = {
    ...fake.client,
    nativePause: true,
    async info() {
      const current = fake.current(scopeName())!;
      return { state: current.state, expiresAtMs: Date.now() + 60_000, onTimeout: "pause" };
    },
  };
  const first = make({ client, store, snapshots: portable.store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "work.txt", "keep");
  await first.teardown(handle);
  assert.equal(portable.puts(), 0);
  assert.equal((await store.get(scope))?.preservationState, "paused");
  const status = await first.computerStatus!(scope);
  assert.equal(status.lifecycleState, "paused");
  assert.equal(fake.current(scopeName())?.state, "paused");
  const restarted = make({ client, store, snapshots: portable.store });
  const resumed = await restarted.provision(layers);
  assert.equal(await restarted.readFile(resumed, "work.txt"), "keep");
});

test("legacy metadata adopts paused native state without reading a broken portable snapshot", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const portable = instrumentedSnapshotStore();
  const first = make({ store, snapshots: portable.store });
  const handle = await first.provision(layers);
  await first.writeFile(handle, "unpublished.txt", "newest native contents");
  await first.teardown(handle);
  const legacy = (await store.get(scope))!;
  await store.put(scope, { sandboxId: legacy.sandboxId, createdAtMs: legacy.createdAtMs });
  portable.failReads(true);
  portable.failWrites(true);
  const client = {
    ...fake.client,
    nativePause: true,
    async info() {
      return { state: fake.current(scopeName())!.state, expiresAtMs: Date.now() + 60_000, onTimeout: "pause" };
    },
  };
  const restarted = make({ client, store, snapshots: portable.store });
  const resumed = await restarted.provision(layers);
  assert.equal(await restarted.readFile(resumed, "unpublished.txt"), "newest native contents");
  await restarted.teardown(resumed);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal((await store.get(scope))?.nativePause, true);
  assert.equal((await store.get(scope))?.preservationState, "paused");
});

test("pause failures are durable and visible and leave the source available for retry", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  let fail = true;
  const client = {
    ...fake.client,
    nativePause: true,
    async create(options: Parameters<typeof fake.client.create>[0]) {
      const session = await fake.client.create(options);
      return {
        ...session,
        async pause() {
          if (fail) throw new Error("provider pause unavailable");
          await session.pause();
        },
      };
    },
  };
  const first = make({ client, store });
  const handle = await first.provision(layers);
  await assert.rejects(first.teardown(handle), /pause unavailable/);
  assert.equal((await store.get(scope))?.preservationState, "pause_failed");
  assert.equal(fake.current(scopeName())?.state, "running");
  fail = false;
  await first.teardown(handle);
  assert.equal((await store.get(scope))?.preservationState, "paused");
  assert.equal((await store.get(scope))?.preservationError, undefined);
});

test("a lost native E2B sandbox requires explicit recovery instead of a blank replacement", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const client = { ...fake.client, nativePause: true };
  const first = make({ client, store });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  fake.expirePaused();
  const restarted = make({ client, store });
  await assert.rejects(restarted.provision(layers), /explicitly import a recovery snapshot/);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("legacy pause preserves dirty home after failed portable checkpoint and retries on an unused turn", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const portable = instrumentedSnapshotStore();
  const first = make({ store, snapshots: portable.store });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  const resumed = await first.provision(layers);
  await first.writeFile(resumed, "unsaved.txt", "needs checkpoint");
  portable.failWrites(true);
  await first.teardown(resumed);
  assert.equal((await store.get(scope))?.homeDirty, true);
  portable.failWrites(false);
  const unused = await first.provision(layers);
  await first.teardown(unused, { homeUnchanged: true });
  assert.equal(portable.puts(), 2);
  assert.equal((await store.get(scope))?.homeDirty, false);
});

test("legacy pause preserves dirty home while portable checkpoints are throttled", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const portable = instrumentedSnapshotStore();
  const first = make({ store, snapshots: portable.store, snapshotIntervalMs: 60_000 });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  const resumed = await first.provision(layers);
  await first.writeFile(resumed, "unsaved.txt", "needs checkpoint");
  await first.teardown(resumed);
  assert.equal(portable.puts(), 1);
  assert.equal((await store.get(scope))?.homeDirty, true);
});

test("destroyScope deletes paused native state without resuming and retains metadata on failure", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
  const record: StoredE2bSandbox = {
    sandboxId: "paused-machine",
    createdAtMs: 0,
    nativePause: true,
    preservationState: "paused",
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
      async connect() {
        throw new Error("must not resume");
      },
      async list() {
        throw new Error("must not discover");
      },
      async kill(id: string) {
        deleted.push(id);
        if (fail) throw new Error("provider temporarily unavailable");
        throw new E2bSandboxGoneError(id, "already gone");
      },
    },
  });
  await assert.rejects(backend.destroyScope!(scope), /temporarily unavailable/);
  assert.deepEqual(await store.get(scope), record);
  fail = false;
  await backend.destroyScope!(scope);
  await backend.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.deepEqual(deleted, ["paused-machine", "paused-machine"]);
});

test("destroyScope clears a live E2B session cache after deleting its stored machine", async () => {
  const store = createMemoryMap<StoredE2bSandbox>();
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
  const store = createMemoryMap<StoredE2bSandbox>();
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
