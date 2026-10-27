import { SandboxProvisionCleanupError } from "../../src/sandbox/sandbox.ts";
import { pollProcess } from "../../src/sandbox/process-poll.ts";
import type { SandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2bSandbox, type StoredE2bSandbox, E2B_BODIES } from "../../src/sandbox/e2b-sandbox.ts";
import { sandboxScopeName } from "../../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { supportsBlobStaging, supportsProcessSessions } from "../../src/sandbox/sandbox.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import { scopeId } from "../../src/types.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD } from "../../src/auth/capability-token.ts";
import { installFakeE2b, type FakeE2b } from "../support/fake-e2b.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { testAdvisoryLock, testSandboxBodies } from "../support/test-database.ts";

let fake: FakeE2b;
let sandbox: Sandbox;
let store: SandboxBodies<StoredE2bSandbox>;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createE2bSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "e2b-ws-"))), {
    store,
    advisoryLock: createNoopAdvisoryLock(),
    client: fake.client,
    tenantConfig: () => ({ sandboxNamePrefix: "qmt" }),
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeE2b();
  store = testSandboxBodies(E2B_BODIES);
  sandbox = make();
});

afterEach(() => fake.cleanup());

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);
});

test("two cores provisioning the same stopped computer create one sandbox", async () => {
  const advisoryLock = testAdvisoryLock();
  await Promise.all([
    make({ advisoryLock, store: testSandboxBodies(E2B_BODIES) }).provision(layers),
    make({ advisoryLock, store: testSandboxBodies(E2B_BODIES) }).provision(layers),
  ]);
  assert.equal(fake.createdCount(scopeName()), 1);
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
  const s1 = make();
  const a = await s1.provision(layers);
  await s1.writeFile(a, "keep.txt", "resident\n");
  const first = fake.current(a.id)?.sandboxId;
  const s2 = make();
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

test("profile advertises provider-managed persistence and process sessions", () => {
  assert.equal(sandbox.profile.backend, "e2b");
  assert.equal(sandbox.profile.writablePersistence, "provider_managed");
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
  assert.match(status.machine, /no machine provisioned yet/);
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

test("a failing checkpoint restore fails the replacement provision instead of cold-starting empty", async () => {
  let failRestore = false;
  const s = make({
    client: {
      ...fake.client,
      async create(options: Parameters<typeof fake.client.create>[0]) {
        if (failRestore && options.fromSnapshot) throw new Error("snapshot service unavailable");
        return fake.client.create(options);
      },
    },
  });
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  fake.expirePaused();
  failRestore = true;
  await assert.rejects(() => s.provision(layers), /snapshot service unavailable/);
  failRestore = false;
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
    tenantConfig: () => ({ capabilitySecret: "blob-secret", apiBaseUrl: "http://core.internal:8080" }),
  });
  assert.equal(supportsBlobStaging(wired), true, "wired up, e2b can move bytes by reference");
});

test("stageOut posts to core's blob endpoint by streaming, never by buffering in the guest", async () => {
  const sb = make({
    blobTransfer: createMemoryBlobTransferStore(),
    tenantConfig: () => ({ capabilitySecret: "blob-secret", apiBaseUrl: "http://core.internal:8080" }),
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
    tenantConfig: () => ({ capabilitySecret: "blob-secret", apiBaseUrl: "http://core.internal:8080" }),
  });
  const h = await sb.provision(layers);
  await assert.rejects(() => sb.stageIn!(h, "inbox/big.bin", "f".repeat(32)), /e2b stageIn/);

  const script = fake.execScripts().find((s: string) => s.includes("/v1/blobs/"))!;
  assert.match(script, /-o .*\.part/, "downloads to a temp file");
  assert.match(script, /mv -f /, "and only then moves it into place");
  assert.match(script, /curl -fsS/, "-f so an HTTP error fails loudly instead of writing the error body");
});

test("used-turn teardown captures a native checkpoint and status does not wake a paused sandbox", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "work.txt", "keep");
  await first.teardown(handle);
  assert.ok((await store.get(scope))?.checkpointId);
  const status = await first.computerStatus!(scope);
  assert.equal(status.lifecycleState, "paused");
  assert.equal(fake.current(scopeName())?.state, "paused");
  const restarted = make();
  const resumed = await restarted.provision(layers);
  assert.equal(await restarted.readFile(resumed, "work.txt"), "keep");
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("a row stored before the shared contract resumes its paused sandbox", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "unpublished.txt", "newest native contents");
  fake.pause(scopeName());
  const store = testSandboxBodies<StoredE2bSandbox>(E2B_BODIES);
  await store.upsert(scope, {
    sandboxId: fake.current(scopeName())!.sandboxId,
    createdAtMs: 0,
    nativePause: true,
    preservationState: "paused",
  } as StoredE2bSandbox);
  const restarted = make({ store });
  const resumed = await restarted.provision(layers);
  assert.equal(resumed.coldStart, false);
  assert.equal(await restarted.readFile(resumed, "unpublished.txt"), "newest native contents");
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("a pause failure is reported and leaves the sandbox running for the next teardown", async () => {
  const errors: string[] = [];
  let fail = true;
  const client = {
    ...fake.client,
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
  const first = make({ client, onError: (e: { code: string }) => errors.push(e.code) });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  assert.deepEqual(errors, ["park_failed"]);
  assert.equal(fake.current(scopeName())?.state, "running");
  fail = false;
  await first.teardown(handle);
  assert.equal(fake.current(scopeName())?.state, "paused");
});

test("a lost E2B sandbox without a checkpoint requires explicit recovery instead of a blank replacement", async () => {
  const errors: string[] = [];
  const client = {
    ...fake.client,
    async create(options: Parameters<typeof fake.client.create>[0]) {
      const session = await fake.client.create(options);
      return {
        ...session,
        async createSnapshot(): Promise<{ snapshotId: string }> {
          throw new Error("snapshot quota exhausted");
        },
      };
    },
  };
  const first = make({ client, store, onError: (e: { code: string }) => errors.push(e.code) });
  const handle = await first.provision(layers);
  await first.teardown(handle);
  assert.equal(fake.current(scopeName())?.state, "paused", "a failed snapshot still lets the pause proceed");
  assert.equal((await store.get(scope))?.snapshotError, "snapshot quota exhausted");
  assert.deepEqual(errors, ["teardown_snapshot_failed"]);
  const status = await first.computerStatus!(scope);
  assert.equal(status.recovery?.error, "snapshot quota exhausted");
  fake.expirePaused();
  const restarted = make({ client, store });
  await assert.rejects(restarted.provision(layers), /explicitly import a recovery snapshot/);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("a lost E2B sandbox is replaced from its persistent checkpoint", async () => {
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "work.txt", "captured before the pause\n");
  await first.teardown(handle);
  const captured = (await store.get(scope))!;
  assert.ok(captured.checkpointId, "used-turn teardown captures a provider snapshot");
  assert.deepEqual(fake.snapshots(), [captured.checkpointId]);
  const paused = await first.computerStatus!(scope);
  assert.equal(paused.recovery?.strategy, "provider_snapshot");
  assert.equal(paused.recovery?.checkpointId, captured.checkpointId);
  fake.expirePaused();
  const restarted = make();
  const revived = await restarted.provision(layers);
  assert.equal(revived.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal(fake.restoredFrom(scopeName()), captured.checkpointId);
  assert.equal(await restarted.readFile(revived, "work.txt"), "captured before the pause\n");
  assert.equal((await store.get(scope))?.sandboxId, fake.current(scopeName())?.sandboxId);
});

test("checkpoints follow the snapshot interval and supersede the previous capture", async () => {
  const throttled = make({ snapshotIntervalSec: 3600 });
  const a = await throttled.provision(layers);
  await throttled.teardown(a);
  const b = await throttled.provision(layers);
  await throttled.teardown(b);
  assert.equal(fake.snapshots().length, 1, "second teardown inside the interval skips the capture");
  const firstId = (await store.get(scope))!.checkpointId!;

  const eager = make({ snapshotIntervalSec: 0 });
  const c = await eager.provision(layers);
  await eager.teardown(c);
  const secondId = (await store.get(scope))!.checkpointId!;
  assert.notEqual(secondId, firstId);
  assert.deepEqual(fake.snapshots(), [secondId], "only the newest snapshot is retained");

  await eager.destroyScope!(scope);
  assert.deepEqual(fake.snapshots(), [], "destroying the scope deletes its snapshot");
});

test("a failed checkpoint leaves the home dirty and is retried on an unused turn", async () => {
  let fail = true;
  const client = {
    ...fake.client,
    async create(options: Parameters<typeof fake.client.create>[0]) {
      const session = await fake.client.create(options);
      return {
        ...session,
        async createSnapshot(): Promise<{ snapshotId: string }> {
          if (fail) throw new Error("snapshot backlog");
          return session.createSnapshot();
        },
      };
    },
  };
  const s = make({ client, store });
  const handle = await s.provision(layers);
  await s.writeFile(handle, "unsaved.txt", "needs checkpoint");
  await s.teardown(handle);
  assert.equal((await store.get(scope))?.homeDirty, true);
  fail = false;
  const unused = await s.provision(layers);
  await s.teardown(unused, { homeUnchanged: true });
  assert.ok((await store.get(scope))?.checkpointId);
  assert.equal((await store.get(scope))?.homeDirty, false);
});

test("restartComputer cold-boots the same sandbox from its disk", async () => {
  const pauses: unknown[] = [];
  const client = {
    ...fake.client,
    async connect(id: string) {
      const session = await fake.client.connect(id);
      return {
        ...session,
        async pause(opts?: { keepMemory?: boolean }) {
          pauses.push(opts);
          await session.pause();
        },
      };
    },
  };
  const s = make({ client });
  const handle = await s.provision(layers);
  await s.writeFile(handle, "disk.txt", "kept");
  await s.teardown(handle);
  await s.restartComputer!(scope);
  assert.deepEqual(pauses, [{ keepMemory: false }]);
  assert.equal(fake.current(scopeName())?.state, "running");
  assert.equal(fake.createdCount(scopeName()), 1);
  const after = await s.provision(layers);
  assert.equal(await s.readFile(after, "disk.txt"), "kept");
});

test("a failing snapshot delete never wedges destroy", async () => {
  const client = {
    ...fake.client,
    async deleteSnapshot(): Promise<void> {
      throw new Error("snapshot API unavailable");
    },
  };
  const s = make({ client, store });
  const h = await s.provision(layers);
  await s.teardown(h);
  assert.ok((await store.get(scope))?.checkpointId);
  await s.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.current(scopeName()), null);
});

test("keepWarm teardown extends the sandbox timeout to the keep-warm horizon", async () => {
  const s = make({ keepWarmSec: 7200 });
  const h = await s.provision(layers);
  await s.teardown(h, { keepWarm: true });
  assert.equal(fake.current(h.id)?.state, "running");
  assert.ok(fake.timeouts(h.id).includes(7200_000), `timeouts: ${fake.timeouts(h.id).join(",")}`);
});

test("a command whose sandbox is lost mid-flight fails loudly instead of running twice", async () => {
  const h = await sandbox.provision(layers);
  fake.loseNextCommand(h.id);
  const before = fake.execScripts().length;
  await assert.rejects(sandbox.run(h, "echo must-not-repeat"), /was lost while a command was running/);
  assert.equal(fake.execScripts().length, before, "the lost command was not re-run");
  const r = await sandbox.run(h, "echo back");
  assert.equal(r.stdout.trim(), "back", "the next command reconnects");
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("an egress proxy is advertised as domain enforcement", () => {
  assert.equal(make({ egressProxyUrl: "https://proxy.example.com" }).profile.egressEnforcement, "domain");
  assert.equal(make().profile.egressEnforcement, "none");
});

test("computerStatus reports provider metrics and the profile learns the sandbox shape", async () => {
  const client = {
    ...fake.client,
    async info() {
      return { state: "running", expiresAtMs: Date.now() + 60_000, cpuCount: 2, memoryMb: 512 };
    },
  };
  const s = make({ client });
  fake.metrics = {
    cpuUsedPct: 12.5,
    cpuCount: 2,
    memUsedBytes: 256 * 2 ** 20,
    memTotalBytes: 512 * 2 ** 20,
    diskUsedBytes: 1.5 * 2 ** 30,
    diskTotalBytes: 20 * 2 ** 30,
  };
  await s.provision(layers);
  const status = await s.computerStatus!(scope);
  assert.deepEqual(status.resources, {
    cpuUsedPct: 12.5,
    memUsedMb: 256,
    memTotalMb: 512,
    diskUsedGb: 1.5,
    diskTotalGb: 20,
  });
  assert.equal(s.profile.spec?.cpus, 2);
  assert.equal(s.profile.spec?.memoryMb, 512);
  assert.equal(s.profile.spec?.diskGb, 20);
});

test("destroyScope deletes paused state without resuming and retains metadata on failure", async () => {
  const record: StoredE2bSandbox = { sandboxId: "paused-machine", checkpointId: "snap-old" };
  await store.upsert(scope, record);
  const deleted: string[] = [];
  let fail = true;
  const backend = make({
    client: {
      ...fake.client,
      async create() {
        throw new Error("must not provision");
      },
      async connect() {
        throw new Error("must not resume");
      },
      async list() {
        return fail || deleted.length < 2 ? [{ sandboxId: "paused-machine", state: "paused" }] : [];
      },
      async kill(id: string) {
        deleted.push(id);
        if (fail) throw new Error("provider temporarily unavailable");
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

test("destroyScope clears a live E2B session cache after deleting its machine", async () => {
  const backend = make();
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
  const backend = make();
  const other = await backend.provision([]);
  const defaultRecord = await store.get("default");
  assert.ok(defaultRecord);
  const handle = await backend.provision(layers);
  await backend.teardown(handle, { destroy: true });
  await backend.teardown(handle, { destroy: true });
  assert.deepEqual(await store.get("default"), defaultRecord);
  assert.equal(fake.current(handle.id), null);
  assert.equal(fake.current(other.id)?.state, "running");
});

test("forced scratch destruction surfaces failure and retries the same sandbox", async () => {
  const killed: string[] = [];
  const client = {
    ...fake.client,
    async kill(id: string) {
      killed.push(id);
      if (killed.length === 1) throw new Error("transient delete failure");
      await fake.client.kill(id);
    },
  };
  const box = make({ client });
  const handle = await box.provision(layers, { scratch: { key: "destroy-retry" } });
  const id = fake.current(handle.id)!.sandboxId;
  await assert.rejects(box.teardown(handle, { destroy: true }), /transient delete failure/);
  await box.teardown(handle, { destroy: true });
  assert.deepEqual(killed, [id, id]);
  assert.equal(fake.current(handle.id), null);
});

test("released scratch handles cannot recreate a persistent sandbox", async () => {
  const handle = await sandbox.provision(layers, { scratch: { key: "released-handle" } });
  await sandbox.teardown(handle, { destroy: true });
  await assert.rejects(sandbox.run(handle, "true"), /is not provisioned/);
  assert.equal(fake.createdCount(handle.id), 1);
});

test("failed scratch preparation retains the sandbox when rollback fails", async () => {
  let kills = 0;
  const box = make({
    client: {
      ...fake.client,
      async create(opts: Parameters<typeof fake.client.create>[0]) {
        const session = await fake.client.create(opts);
        return {
          ...session,
          async runCommand() {
            throw new Error("preparation failed");
          },
        };
      },
      async kill(id: string) {
        if (kills++ === 0) throw new Error("kill-boom");
        await fake.client.kill(id);
      },
    },
  });
  let pending: import("../../src/sandbox/sandbox.ts").SandboxHandle | undefined;
  await assert.rejects(box.provision(layers, { scratch: { key: "failed-preparation" } }), (error: Error) => {
    assert.ok(error instanceof SandboxProvisionCleanupError);
    pending = error.handle;
    assert.equal((error.cause as Error).message, "kill-boom");
    assert.match(error.message, /preparation failed/);
    return true;
  });
  assert.ok(pending);
  await box.teardown(pending, { destroy: true });
  assert.equal(kills, 2);
});
