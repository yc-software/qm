import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenderSandbox,
  type StoredRenderSandbox,
  type StoredRenderCleanup,
  type StoredRenderNamespace,
  type StoredRenderScratch,
} from "../src/sandbox/render-sandbox.ts";
import { createLocalBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { computerVerdict, supportsAgentComputerExport, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { createSdkRenderClient } from "../src/sandbox/render-client.ts";
import { createRenderBase, type RenderBase, type StoredRenderBase } from "../src/sandbox/render-base.ts";
import { createSandboxResources } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { createFakeRender, serveFakeRenderApi } from "./support/fake-render.ts";
import { testMap, testAdvisoryLock, testCountedAdvisoryLock } from "./support/test-database.ts";

const BASE_REF = `ghcr.io/acme/sandbox-base:0123456789abcdef0123456789abcdef01234567@sha256:${"a".repeat(64)}`;

function setup(
  t: TestContext,
  options: {
    http?: boolean;
    intercept?: (request: Request) => Response | undefined;
    advisoryLock?: ReturnType<typeof testAdvisoryLock>;
  } = {},
) {
  const fake = createFakeRender();
  const http = options.http ? serveFakeRenderApi(t, fake, options.intercept) : undefined;
  const client = http ? createSdkRenderClient({ apiKey: "render-test-key", workspaceId: "tea-test" }) : fake.client;
  const dir = mkdtempSync(join(tmpdir(), "render-ws-"));
  const blobTransfer = createLocalBlobTransferStore(join(dir, "blobs"));
  const store = testMap<StoredRenderSandbox>();
  const scratchStore = testMap<StoredRenderScratch>();
  const cleanupStore = testMap<StoredRenderCleanup>();
  const namespaceStore = testMap<StoredRenderNamespace>();
  const advisoryLock = options.advisoryLock ?? testAdvisoryLock();
  const errors: Array<{ code: string; message: string }> = [];
  let golden = { ref: BASE_REF, snapshotId: fake.seedGolden(BASE_REF) };
  const base: RenderBase = {
    ready: async () => golden,
    prepare: async () => {},
  };
  const useGolden = (ref: string) => {
    golden = { ref, snapshotId: fake.seedGolden(ref) };
    return golden.snapshotId;
  };
  const make = (checkpointIntervalMs = -1, goldens = base) =>
    createRenderSandbox({
      client,
      base: goldens,
      store,
      scratchStore,
      cleanupStore,
      advisoryLock,
      namespaceStore,
      blobTransfer,
      checkpointIntervalMs,
      onError: (error) => errors.push({ code: error.code, message: error.message }),
    });
  const scope = scopeId("personal", "tester");
  t.after(() => {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    fake,
    client,
    http,
    store,
    scratchStore,
    cleanupStore,
    make,
    scope,
    blobTransfer,
    dir,
    advisoryLock,
    errors,
    useGolden,
  };
}

const processPath = "/root/.agent-proc/11111111-1111-1111-1111-111111111111";
async function startBackgroundProcess(fake: ReturnType<typeof createFakeRender>, sandboxId: string): Promise<void> {
  await fake.client.writeFileBytes(sandboxId, `${processPath}/cmd`, Buffer.from("background work"));
  await fake.client.writeFileBytes(sandboxId, `${processPath}/started`, Buffer.from("1"));
}
const finishBackgroundProcess = (fake: ReturnType<typeof createFakeRender>, sandboxId: string): Promise<void> =>
  fake.client.writeFileBytes(sandboxId, `${processPath}/code`, Buffer.from("0"));

test("Render keeps turn and background process secrets out of run token requests and runs scripts past the argument limit", async (t) => {
  const { make, http, scope } = setup(t, { http: true });
  const sandbox = make();
  const turnSecret = "turn-secret-8d1f";
  const processSecret = "process-secret-2c7a";
  const handle = await sandbox.provision(scope, { env: { QM_TURN_TOKEN: turnSecret } });
  assert.equal((await sandbox.run(handle, 'printf %s "$QM_TURN_TOKEN"')).stdout, turnSecret);
  const payload = "y".repeat(200 * 1024);
  assert.equal(
    (await sandbox.run(handle, `payload='${payload}'; printf %s "\${#payload}"`)).stdout,
    String(payload.length),
  );
  assert.ok(supportsProcessSessions(sandbox));
  const { processId } = await sandbox.startProcess(handle, 'printf %s "$QM_PROCESS_TOKEN:$QM_TURN_TOKEN"', {
    env: { QM_PROCESS_TOKEN: processSecret },
  });
  const { output, status } = await pollProcess(sandbox, handle, processId, { deadlineMs: 20_000, waitMs: 100 });
  assert.deepEqual(status, { state: "exited", code: 0 });
  assert.equal(output, `${processSecret}:${turnSecret}`);
  const runs = http!.tokenRequests.filter((request) => request.operation === "stream");
  assert.ok(runs.length > 3);
  for (const request of http!.tokenRequests) {
    for (const value of [turnSecret, processSecret, payload.slice(0, 64), "export "])
      assert.equal(request.body.includes(value), false, `${request.operation} token request carried ${value}`);
  }
  for (const request of runs) {
    const { command } = JSON.parse(request.body) as { command: string };
    assert.match(
      command,
      /^(sh -c 's=\$\(date \+%s\); \$\(command -v setsid\) timeout -k \d+ (\d+) sh '\\''\/dev\/\.qm-run\/[0-9a-f-]{36}\.sh'\\'' & p=\$!; wait \$p; rc=\$\?; if \[ \$rc -eq 124 \] \|\| \[ \$rc -eq 137 \]; then \[ \$\(\(\$\(date \+%s\) - s\)\) -lt \2 \] \|\| kill -s KILL -- -\$p 2>\/dev\/null; fi; exit \$rc'|test -f '[^']+')$/,
    );
  }
});

test("Render resumes from its native checkpoint through transient API errors and sends a failed exec once", async (t) => {
  const failures: Array<{ method: string; path: RegExp; status: number }> = [];
  const injected: string[] = [];
  const { make, fake, http, store, scope } = setup(t, {
    http: true,
    intercept: (request) => {
      const url = new URL(request.url);
      const index = failures.findIndex((item) => item.method === request.method && item.path.test(url.pathname));
      if (index < 0) return undefined;
      const [failure] = failures.splice(index, 1);
      injected.push(`${failure!.status} ${request.method} ${url.pathname}`);
      return Response.json({ message: "transient" }, { status: failure!.status, headers: { "retry-after": "0" } });
    },
  });
  const sandbox = make();
  await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  const checkpoint = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  failures.push(
    { method: "GET", path: new RegExp(`^/v1/sandboxes/${stored.sandboxId}$`), status: 503 },
    { method: "GET", path: new RegExp(`/snapshots/${checkpoint}$`), status: 429 },
  );
  const resumed = await sandbox.provision(scope);
  assert.equal((await sandbox.run(resumed, "echo resumed")).stdout, "resumed\n");
  assert.deepEqual(injected, [
    `503 GET /v1/sandboxes/${stored.sandboxId}`,
    `429 GET /v1/sandbox-groups/sbg-test/snapshots/${checkpoint}`,
  ]);
  assert.equal(fake.createdFrom.at(-1), checkpoint);
  const runs = () => http!.tokenRequests.filter((request) => request.operation === "stream");
  const before = runs().length;
  failures.push({ method: "POST", path: /\/runs\/stream\/token$/, status: 503 });
  await assert.rejects(sandbox.run(resumed, "touch /root/workspace/never-created"), /transient/);
  assert.equal(injected.filter((entry) => entry.startsWith("503 POST")).length, 1);
  assert.deepEqual(
    runs()
      .slice(before)
      .map((request) => (JSON.parse(request.body) as { command: string }).command.split(" ").slice(0, 2).join(" ")),
    ["rm -f"],
  );
  assert.equal(
    await fake.client.readFileBytes((await store.get(scope))!.sandboxId, "/root/workspace/never-created"),
    null,
  );
});

test("Render declares the tools and resources of the base image", (t) => {
  const { make } = setup(t);
  const { spec } = make().profile;
  for (const tool of ["git", "curl", "wget", "jq", "python3", "gh", "aws (CLI v2)"])
    assert.ok(spec?.tools?.includes(tool), tool);
  for (const tool of ["gcloud", "kubectl", "flyctl", "glab"]) assert.ok(spec?.notInstalled?.includes(tool), tool);
  assert.deepEqual([spec?.cpus, spec?.memoryMb, spec?.diskGb], [2, 4096, 10]);
});

test("Render starts computers and disposable sandboxes from the golden snapshot and keeps a computer's base image", async (t) => {
  const { make, fake, store, scope, useGolden } = setup(t);
  const sandbox = make();
  const goldenA = fake.createdFrom.length;
  const handle = await sandbox.provision(scope);
  const first = (await store.get(scope))!;
  assert.match(fake.createdFrom[goldenA]!, /^snp-golden-/);
  assert.equal(first.baseImage, BASE_REF);
  assert.equal((await sandbox.run(handle, "cat /root/.base-image")).stdout.trim(), BASE_REF);
  await sandbox.teardown(handle);
  await fake.client.terminate(first.sandboxId);

  const refB = BASE_REF.replace("0123456789abcdef", "fedcba9876543210");
  const goldenB = useGolden(refB);
  const restored = await sandbox.provision(scope);
  assert.equal(fake.createdFrom.at(-1), (await store.get(scope))!.checkpoint!.id);
  assert.equal((await store.get(scope))!.baseImage, BASE_REF);
  assert.equal((await sandbox.run(restored, "cat /root/.base-image")).stdout.trim(), BASE_REF);

  const disposable = await sandbox.provision(scope, { scratch: { key: "job" } });
  assert.equal(fake.createdFrom.at(-1), goldenB);
  assert.equal((await sandbox.run(disposable, "cat /root/.base-image")).stdout.trim(), refB);
});

test("Render waits for the deployment's first golden snapshot before starting a computer", async (t) => {
  const { fake, store, scope, make } = setup(t, { http: true });
  const source = "ghcr.io/acme/sandbox-base:0123456789abcdef0123456789abcdef01234567";
  fake.publishImage(source, `sha256:${"a".repeat(64)}`);
  const goldens = createRenderBase({
    client: createSdkRenderClient({ apiKey: "render-test-key", workspaceId: "tea-test" }),
    store: testMap<StoredRenderBase>(),
    image: BASE_REF,
    pollMs: 5,
  });
  const statuses: string[] = [];
  const sandbox = make(-1, goldens);
  const provisioning = sandbox.provision(scope, { onStatus: (text) => statuses.push(text) });
  while (!statuses.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await goldens.prepare(new AbortController().signal);
  const handle = await provisioning;
  assert.deepEqual(statuses.slice(0, 2), [
    "Preparing the sandbox image for this deployment; the first start takes a few minutes",
    "Starting your computer…",
  ]);
  assert.equal((await store.get(scope))!.baseImage, BASE_REF);
  assert.equal(
    (await sandbox.run(handle, "cat /root/.base-image")).stdout.trim(),
    `${source}@sha256:${"a".repeat(64)}`,
  );
});

test("Render provisions one durable sandbox across two cores and executes in its workspace", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const first = make();
  const second = make();
  const [a, b] = await Promise.all([
    first.provision(scope, { env: { QM_TEST_VALUE: "hello" } }),
    second.provision(scope),
  ]);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(a.id, b.id);
  assert.equal(first.profile.backend, "render");
  assert.equal(first.profile.writablePersistence, "provider_managed");
  assert.ok(supportsAgentComputerExport(first));
  assert.ok(supportsProcessSessions(first));
  assert.ok((await store.get(scope))?.checkpoint);
  const result = await first.run(a, "printf '%s\\n' \"$QM_TEST_VALUE\"; pwd; printf problem >&2; exit 7");
  assert.match(result.stdout, /^hello\n.*workspace\n$/);
  assert.equal(result.stderr, "problem");
  assert.equal(result.code, 7);
});

test("Render restores files from its checkpoint after sandbox expiry and a core restart", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const first = make();
  const handle = await first.provision(scope);
  await first.writeFile(handle, "nested/work.txt", "retained");
  await first.teardown(handle);
  const stored = (await store.get(scope))!;
  const checkpointId = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  const second = make();
  const restored = await second.provision(scope);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.createdFrom[1], checkpointId);
  assert.equal(fake.snapshotSource(checkpointId)?.name, "qm-personal-tester-e41213");
  assert.equal(await second.readFile(restored, "nested/work.txt"), "retained");
  assert.equal(await second.readFile(restored, "missing"), null);
  const binary = Buffer.from([0, 255, 4, 0, 128]);
  await second.writeFileBytes(restored, "binary", binary);
  assert.deepEqual(await second.readFileBytes(restored, "binary"), binary);
});

test("Render checkpoint failure keeps the sandbox running and its last native checkpoint until a new one exists", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "new", "not checkpointed");
  fake.failCheckpoint(new Error("snapshot outage"));
  await sandbox.teardown(handle);
  const after = (await store.get(scope))!;
  assert.equal(after.checkpoint?.id, before.checkpoint!.id);
  assert.equal(after.homeDirty, true);
  assert.equal(fake.snapshots.has(before.checkpoint!.id), true);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  assert.equal(await sandbox.readFile(handle, "new"), "not checkpointed");
  assert.equal(after.recoveryError, "snapshot outage");
  fake.failCheckpoint();
  await sandbox.teardown(handle);
  const recovered = (await store.get(scope))!;
  assert.notEqual(recovered.checkpoint!.id, before.checkpoint!.id);
  assert.equal(recovered.homeDirty, false);
  assert.equal(recovered.recoveryError, undefined);
  assert.equal(fake.snapshots.has(before.checkpoint!.id), false);
});

test("Render replaces a suspended sandbox from its checkpoint", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "kept", "before suspension");
  await sandbox.teardown(handle);
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.status = "suspended";
  const restored = await make().provision(scope);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
  assert.equal(fake.createdFrom[1], stored.checkpoint!.id);
  assert.equal(await sandbox.readFile(restored, "kept"), "before suspension");
});

test("Render refuses an empty replacement for an existing sandbox without a snapshot", async (t) => {
  const { make, fake, store, scope } = setup(t);
  await make().provision(scope);
  const stored = (await store.get(scope))!;
  await store.put(scope, {
    sandboxId: stored.sandboxId,
    expiresAtMs: stored.expiresAtMs,
    lastActivityMs: 0,
    baseImage: stored.baseImage,
  });
  await fake.client.terminate(stored.sandboxId);
  await assert.rejects(make().provision(scope), /no available native snapshot/);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal((await store.get(scope))!.sandboxId, stored.sandboxId);
});

function blockCommands(fake: ReturnType<typeof createFakeRender>, count = 1) {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  let entered = 0;
  const run = fake.client.runScript;
  fake.client.runScript = async (id, script, timeoutSec) => {
    if (script.includes("blocked-command")) {
      if (++entered === count) reached.resolve();
      await gate.promise;
    }
    return run(id, script, timeoutSec);
  };
  return Object.assign(gate, { reached: reached.promise });
}

test(
  "Render lets other turns provision, tear down, checkpoint, and restart during a command without waiting for it",
  { timeout: 60_000 },
  async (t) => {
    const { make, fake, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    const gate = blockCommands(fake);
    const blocked = sandbox.run(handle, "echo blocked-command");
    await gate.reached;
    assert.equal((await sandbox.run(handle, "echo concurrent")).stdout, "concurrent\n");
    const before = (await store.get(scope))!;
    const other = make();
    const second = await other.provision(scope);
    await other.writeFile(second, "second-turn", "saved");
    await other.teardown(second);
    await sandbox.persistHomeSnapshot!(scope);
    assert.notEqual((await store.get(scope))!.checkpoint!.id, before.checkpoint!.id);
    assert.equal((await store.get(scope))!.homeDirty, false);
    gate.resolve();
    assert.equal((await blocked).stdout, "blocked-command\n");
    assert.equal((await store.get(scope))!.homeDirty, true);
    const cut = blockCommands(fake);
    const cutOff = sandbox.run(handle, "echo blocked-command");
    await cut.reached;
    await sandbox.restartComputer!(scope);
    assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
    cut.resolve();
    await assert.rejects(cutOff, /was restarted or stopped while the command ran/);
    assert.equal((await store.get(scope))!.stopped, undefined);
    const restored = await make().provision(scope);
    assert.equal(await sandbox.readFile(restored, "second-turn"), "saved");
  },
);

test(
  "Render runs concurrent commands without holding a Postgres session connection",
  { timeout: 60_000 },
  async (t) => {
    const sessions = testCountedAdvisoryLock();
    t.after(() => sessions.close());
    const { make, fake, scope } = setup(t, { advisoryLock: sessions.lock });
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    const parallel = 8;
    const gate = blockCommands(fake, parallel);
    const commands = Array.from({ length: parallel }, (_, i) => sandbox.run(handle, `echo blocked-command ${i}`));
    try {
      await gate.reached;
      assert.equal(sessions.held(), 0);
    } finally {
      gate.resolve();
    }
    assert.equal((await Promise.all(commands)).length, parallel);
  },
);

test("Render turns share one computer through the sandbox router", { timeout: 60_000 }, async (t) => {
  const { make, fake, scope, advisoryLock } = setup(t);
  const render = make();
  const resources = createSandboxResources({
    records: testMap(),
    defaults: testMap(),
    backends: { render },
    defaultBackend: "render",
    lock: advisoryLock,
    canUseScope: async () => true,
  });
  const router = createSandboxRouter({ backends: { render }, defaultBackend: "render", resources });
  const record = await resources.create("tester", scope, "render");
  await resources.setDefault("tester", scope, record.id);
  const first = await router.provision(scope);
  assert.equal(first.resourceId, record.id);
  const gate = blockCommands(fake);
  const blocked = router.run(first, "echo blocked-command");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await router.provision(scope);
  assert.equal((await router.run(second, "echo concurrent")).stdout, "concurrent\n");
  await router.teardown(second);
  gate.resolve();
  assert.equal((await blocked).stdout, "blocked-command\n");
  await router.teardown(first);
});

test("Render reaping keeps a sandbox whose background process starts after the first process probe", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const run = fake.client.runScript;
  let started = false;
  fake.client.runScript = async (id, script, timeoutSec) => {
    const result = await run(id, script, timeoutSec);
    if (script.includes(".agent-proc") && !started) {
      started = true;
      await startBackgroundProcess(fake, id);
    }
    return result;
  };
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(started, true);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  assert.equal((await sandbox.listProcesses!(handle)).length, 1);
});

test("Render scratch sandboxes are shared only until the last handle is released", async (t) => {
  const { make, fake, scope, store } = setup(t);
  const sandbox = make();
  const a = await sandbox.provision(scope, { scratch: { key: "job" } });
  const b = await sandbox.provision(scope, { scratch: { key: "job" } });
  assert.equal(fake.createdFrom.length, 1);
  assert.equal((await store.entries()).length, 0);
  await sandbox.teardown(a);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  await sandbox.teardown(b);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.equal(fake.snapshots.size, 0);
});

test("Render destroys both the sandbox and its checkpoint", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
});

test("Render does not replay a command when an exec call fails", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  await assert.rejects(sandbox.run(handle, "side-effect"), /has stopped; the next turn restores it/);
  assert.equal(fake.createdFrom.length, 1);
});

test("Render clears expired temporary credentials after a native restore", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const source = make();
  const handle = await source.provision(scope);
  await fake.client.writeFileBytes(
    (await store.get(scope))!.sandboxId,
    "/root/.cred-state-secret",
    Buffer.from("expired"),
  );
  await source.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  const target = make();
  await target.provision(scope);
  assert.equal(await fake.client.readFileBytes((await store.get(scope))!.sandboxId, "/root/.cred-state-secret"), null);
});

test("Render disposes a new native checkpoint when its staging record write fails", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const info = await fake.client.create({ lifetimeSec: 86400 });
  await store.put(scope, {
    sandboxId: info.id,
    expiresAtMs: info.expiresAtMs,
    lastActivityMs: Date.now(),
    baseImage: BASE_REF,
  });
  const merge = store.merge;
  let failed = false;
  store.merge = async (key, patch) => {
    if (!failed && patch.retiredResources?.some((resource) => resource.checkpoint)) {
      failed = true;
      throw new Error("pending record outage");
    }
    return merge(key, patch);
  };
  const sandbox = make();
  await assert.rejects(sandbox.persistHomeSnapshot!(scope), /pending record outage/);
  const stored = (await store.get(scope))!;
  assert.equal(stored.recoveryError, "pending record outage");
  assert.equal(stored.checkpoint, undefined);
  assert.equal(stored.retiredResources, undefined);
  assert.equal(fake.snapshots.size, 0);
  await sandbox.destroyScope!(scope);
  assert.equal(await store.get(scope), null);
});

test("Render retains the provider reason when a native checkpoint fails", async (t) => {
  const { make, fake, store, scope, errors } = setup(t);
  const create = fake.client.createSnapshot;
  fake.client.createSnapshot = async (id, name) => {
    const saved = fake.snapshots.get((await create(id, name)).id)!;
    saved.status = "failed";
    saved.error = "Provider: insufficient snapshot capacity";
    return { ...saved };
  };
  await assert.rejects(make().provision(scope), /insufficient snapshot capacity/);
  assert.match((await store.get(scope))!.recoveryError!, /insufficient snapshot capacity/);
  assert.ok(
    errors.some(
      ({ code, message }) => code === "native_checkpoint_failed" && message.includes("insufficient snapshot capacity"),
    ),
  );
});

test("Render finishes a destroy that stopped after it wrote the cleanup record", async (t) => {
  const { make, fake, store, scope, cleanupStore } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.teardown(handle);
  const before = (await store.get(scope))!;
  await cleanupStore.put(scope, {
    resources: [{ sandboxId: before.sandboxId, checkpoint: before.checkpoint }],
  });
  const replacement = await make().provision(scope);
  assert.equal(replacement.coldStart, true);
  assert.equal(await cleanupStore.get(scope), null);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.equal(fake.snapshots.has(before.checkpoint!.id), false);
  assert.notEqual((await store.get(scope))!.sandboxId, before.sandboxId);
});

test("Render removes a destroyed scope at once and deletes a retired checkpoint that is still being created later", async (t) => {
  const { make, fake, store, scope, cleanupStore } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.teardown(handle);
  const before = (await store.get(scope))!;
  const stray = await fake.client.createSnapshot(before.sandboxId, "qm-stray");
  fake.snapshots.get(stray.id)!.status = "creating";
  await store.merge(scope, { retiredResources: [{ checkpoint: { ...stray, status: "creating" } }] });
  await assert.rejects(sandbox.destroyScope!(scope), /snapshot_creating/);
  assert.equal(await store.get(scope), null);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.deepEqual([...fake.snapshots.keys()], [stray.id]);
  assert.equal((await sandbox.computerStatus!(scope)).recovery?.state, "cleanup_pending");
  const replacement = await make().provision(scope);
  assert.equal(replacement.coldStart, true);
  fake.snapshots.get(stray.id)!.status = "available";
  await make().reapDeepIdle!(3600_000);
  assert.equal(await cleanupStore.get(scope), null);
  assert.equal(fake.snapshots.has(stray.id), false);
});
test("Render checkpoints background changes even when deep idle reaping is disabled", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "background", "retained output");
  const stale = Date.now() - 360_000;
  await store.merge(scope, { savedAtMs: stale, lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  const checkpointAtMs = (await store.get(scope))!.savedAtMs!;
  assert.ok(checkpointAtMs > stale);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, checkpointAtMs);
  await fake.client.terminate(stored.sandboxId);
  const other = make();
  const restored = await other.provision(scope);
  assert.equal(await other.readFile(restored, "background"), "retained output");
});

test(
  "Render keeps a computer running through a long command and stops it once idle",
  { timeout: 60_000 },
  async (t) => {
    const { make, fake, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    const { sandboxId } = (await store.get(scope))!;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    const gate = blockCommands(fake);
    const building = sandbox.run(handle, "echo blocked-command");
    await gate.reached;
    const fresh = async (): Promise<boolean> => Date.now() - (await store.get(scope))!.lastActivityMs < 60_000;
    for (let step = 0; step < 10; step++) {
      t.mock.timers.tick(30_000);
      for (let attempt = 0; attempt < 100 && !(await fresh()); attempt++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(await fresh(), "the running command keeps its activity fresh");
    }
    assert.deepEqual(await make().reapDeepIdle!(1), { reaped: 0 });
    assert.equal(fake.sandboxes.get(sandboxId)?.status, "running");
    gate.resolve();
    assert.equal((await building).stdout, "blocked-command\n");
    assert.equal((await store.get(scope))!.homeDirty, true);
    t.mock.timers.tick(4 * 60_000);
    assert.deepEqual(await make().reapDeepIdle!(1), { reaped: 1 });
    assert.equal(fake.sandboxes.get(sandboxId)?.status, "terminated");
  },
);

test("Render leaves a computer and its credentials alone when a command starts during its idle check", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const { sandboxId } = (await store.get(scope))!;
  await fake.client.writeFileBytes(sandboxId, "/tmp/agent-creds/gh", Buffer.from("token"));
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const run = fake.client.runScript;
  let late: Promise<unknown> | undefined;
  fake.client.runScript = async (id, script, timeoutSec) => {
    const result = await run(id, script, timeoutSec);
    if (script.includes(".agent-proc")) await (late ??= sandbox.run(handle, "echo late"));
    return result;
  };
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get(sandboxId)?.status, "running");
  assert.equal(String(await fake.client.readFileBytes(sandboxId, "/tmp/agent-creds/gh")), "token");
  assert.equal((await store.get(scope))!.stopped, undefined);
});

test("Render refuses a write that starts during its idle-stop checkpoint", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const { sandboxId } = (await store.get(scope))!;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const create = fake.client.createSnapshot;
  let late: Promise<unknown> | undefined;
  t.mock.method(fake.client, "createSnapshot", async (id: string, name: string) => {
    const snapshot = await create(id, name);
    late ??= sandbox.writeFile(handle, "late", "refused").catch((error: unknown) => error);
    await late;
    return snapshot;
  });
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 1 });
  assert.match(String(await late), /is being restarted or stopped; try again in a moment/);
  assert.equal(fake.sandboxes.get(sandboxId)?.status, "terminated");
});

test("Render reports a write that finishes during a restart instead of losing it", async (t) => {
  const { make, fake, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const landed = Promise.withResolvers<void>();
  const write = fake.client.writeFileBytes;
  t.mock.method(fake.client, "writeFileBytes", async (id: string, path: string, data: Uint8Array) => {
    if (!path.endsWith("/late")) return write(id, path, data);
    reached.resolve();
    await gate.promise;
    await write(id, path, data);
    landed.resolve();
  });
  const create = fake.client.createSnapshot;
  t.mock.method(fake.client, "createSnapshot", async (id: string, name: string) => {
    const snapshot = await create(id, name);
    gate.resolve();
    await landed.promise;
    return snapshot;
  });
  const writing = sandbox.writeFile(handle, "late", "after the snapshot").catch((error: unknown) => error);
  await reached.promise;
  await sandbox.restartComputer!(scope);
  assert.match(String(await writing), /was restarted or stopped while the command ran/);
});

test("Render keeps a write that finishes before a restart takes its snapshot", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const write = fake.client.writeFileBytes;
  t.mock.method(fake.client, "writeFileBytes", async (id: string, path: string, data: Uint8Array) => {
    if (path.endsWith("/early")) {
      reached.resolve();
      await gate.promise;
    }
    return write(id, path, data);
  });
  const writing = sandbox.writeFile(handle, "early", "in the snapshot").then(
    () => "kept",
    (error: unknown) => error,
  );
  await reached.promise;
  const merge = store.merge;
  t.mock.method(store, "merge", async (id: string, patch: Partial<StoredRenderSandbox>) => {
    if (patch.homeDirty === false) {
      gate.resolve();
      await writing;
    }
    return merge(id, patch);
  });
  await sandbox.restartComputer!(scope);
  assert.equal(await writing, "kept");
  assert.equal(await sandbox.readFile(handle, "early"), "in the snapshot");
});

test("Render finishes an idle stop that a crashed core left half done", async (t) => {
  const { make, fake, store, scope } = setup(t);
  await make().provision(scope);
  const { sandboxId } = (await store.get(scope))!;
  await store.merge(scope, { stopped: true, stopping: true, lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get(sandboxId)?.status, "terminated");
  assert.equal((await store.get(scope))!.stopping, undefined);
});

test("Render returns a finished command's result when it cannot confirm the write afterwards", async (t) => {
  const { make, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const get = store.get;
  let calls = 0;
  t.mock.method(store, "get", async (id: string) => {
    if (++calls === 2) throw new Error("database blip");
    return get(id);
  });
  assert.equal((await sandbox.run(handle, "echo ran")).stdout, "ran\n");
});

test("Render skips remote probes and checkpoints for a recently used sandbox", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  await store.merge(scope, { savedAtMs: Date.now() - 360_000 });
  const before = (await store.get(scope))!;
  const get = t.mock.method(fake.client, "get");
  const commands = fake.commands.length;
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(fake.commands.length, commands);
  assert.equal((await store.get(scope))!.savedAtMs, before.savedAtMs);
  await make().provision(scope);
  assert.ok(fake.commands.slice(commands).every((command) => !command.includes(".agent-proc")));
  assert.equal((await store.get(scope))!.savedAtMs, before.savedAtMs);
});

test("Render leaves an idle sandbox with a running process running", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  const before = (await store.get(scope))!;
  await startBackgroundProcess(fake, before.sandboxId);
  const stale = Date.now() - 360_000;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000, savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, stale);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
});

test("Render records command and file activity without a write for each operation", async (t) => {
  const { make, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  await store.merge(scope, { lastActivityMs: now - 7200_000 });
  const update = t.mock.method(store, "update");
  await sandbox.run(handle, "true");
  await sandbox.writeFile(handle, "activity", "retained");
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(await make(5 * 60_000).reapDeepIdle!(3600_000), { reaped: 0 });
  now += 60_000;
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(update.mock.callCount(), 2);
});

for (const operation of ["command", "upload"]) {
  test(`Render recovers ${operation} work after core restart without teardown`, async (t) => {
    const { make, fake, store, scope } = setup(t);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const sandbox = make(5 * 60_000);
    const handle = await sandbox.provision(scope);
    if (operation === "command") await sandbox.run(handle, "printf retained > crash-work");
    else await sandbox.writeFileBytes(handle, "crash-work", Buffer.from("retained"));
    now += 6 * 60_000;
    const next = make(5 * 60_000);
    assert.deepEqual(await next.reapDeepIdle!(0), { reaped: 0 });
    await fake.client.terminate((await store.get(scope))!.sandboxId);
    const restored = await next.provision(scope);
    assert.equal(await next.readFile(restored, "crash-work"), "retained");
  });
}

test("Render preserves a write that arrives during native snapshot capture", async (t) => {
  const { make, fake, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = fake.client.createSnapshot;
  t.mock.method(fake.client, "createSnapshot", async (id: string, name: string) => {
    const snapshot = await create(id, name);
    captured.resolve();
    await release.promise;
    return snapshot;
  });
  const checkpoint = sandbox.persistHomeSnapshot!(scope);
  await captured.promise;
  const write = sandbox.writeFile(handle, "after-capture", "retained");
  await new Promise<void>((resolve) => setImmediate(resolve));
  release.resolve();
  await Promise.all([checkpoint, write]);
  now += 6 * 60_000;
  const next = make(5 * 60_000);
  await next.reapDeepIdle!(0);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  const restored = await next.provision(scope);
  assert.equal(await next.readFile(restored, "after-capture"), "retained");
});
test("Render rechecks activity after it waits for a sandbox operation", async (t) => {
  const { make, fake, store, scope, advisoryLock } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = advisoryLock.withLock(`render-sandbox:${handle.id}`, async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const listed = Promise.withResolvers<void>();
  const read = store.entries;
  t.mock.method(store, "entries", async () => {
    const result = await read();
    listed.resolve();
    return result;
  });
  const get = t.mock.method(fake.client, "get");
  const reaping = sandbox.reapDeepIdle!(3600_000);
  await listed.promise;
  await store.merge(scope, { lastActivityMs: Date.now() });
  release.resolve();
  await holding;
  assert.deepEqual(await reaping, { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
});

test("Render saves a home in use without stopping its sandbox and stops it once idle", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "latest", "retained before stopping");
  const before = (await store.get(scope))!;
  const stale = Date.now() - 360_000;
  await store.merge(scope, { savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.ok((await store.get(scope))!.savedAtMs! > stale);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const get = t.mock.method(fake.client, "get");
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.equal((await store.get(scope))!.stopped, true);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(get.mock.callCount(), 1);
  const next = make();
  const restored = await next.provision(scope);
  assert.equal(await next.readFile(restored, "latest"), "retained before stopping");
});

test("Render clears a stale stopped mark when its computer is still running", async (t) => {
  const { make, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  await store.merge(scope, { stopped: true });
  const handle = await sandbox.provision(scope);
  assert.equal((await store.get(scope))!.stopped, undefined);
  assert.equal((await sandbox.run(handle, "echo ok")).stdout, "ok\n");
});

test("Render clears temporary credentials before the checkpoint of an idle stop", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const running = (await store.get(scope))!.sandboxId;
  await fake.client.writeFileBytes(running, "/root/.cred-state-secret", Buffer.from("token"));
  await fake.client.writeFileBytes(running, "/tmp/agent-creds/gh", Buffer.from("token"));
  await sandbox.writeFile(handle, "kept", "work");
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  const stopped = (await store.get(scope))!;
  assert.equal(stopped.stopped, true);
  const copy = await fake.client.create({ snapshotId: stopped.checkpoint!.id, lifetimeSec: 60 });
  assert.equal(await fake.client.readFileBytes(copy.id, "/root/.cred-state-secret"), null);
  assert.equal(await fake.client.readFileBytes(copy.id, "/tmp/agent-creds/gh"), null);
  assert.equal(String(await fake.client.readFileBytes(copy.id, "/root/workspace/kept")), "work");
});

test("Render tells a turn that its computer was stopped instead of running on a dead sandbox", async (t) => {
  const { make, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  await assert.rejects(sandbox.run(handle, "true"), /has stopped; the next turn restores it from its last checkpoint/);
  const restored = await sandbox.provision(scope);
  assert.equal((await sandbox.run(restored, "echo ok")).stdout, "ok\n");
});

test("Render stops an idle computer at its idle limit even when deep idle allows longer", async (t) => {
  const { make, fake, store, scope } = setup(t);
  await make().provision(scope);
  const stored = (await store.get(scope))!;
  await store.merge(scope, { lastActivityMs: Date.now() - 50 * 60_000 });
  const threeDays = 3 * 24 * 3600_000;
  assert.deepEqual(await make().reapDeepIdle!(threeDays), { reaped: 0 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  await store.merge(scope, { lastActivityMs: Date.now() - 70 * 60_000 });
  assert.deepEqual(await make().reapDeepIdle!(threeDays), { reaped: 1 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render creates computers with a 30-day lifetime and disposable sandboxes with a 24-hour lifetime", async (t) => {
  const { make, fake, scope } = setup(t);
  const create = t.mock.method(fake.client, "create");
  const sandbox = make();
  const computer = await sandbox.provision(scope);
  const disposable = await sandbox.provision(scope, { scratch: { key: "job" } });
  assert.deepEqual(
    create.mock.calls.map((call) => call.arguments[0]?.lifetimeSec),
    [2592000, 86400],
  );
  await sandbox.teardown(disposable);
  await sandbox.teardown(computer);
});

for (const failure of ["cleanup release", "record write"] as const) {
  test(`Render terminates a sandbox that a failed ${failure} left untracked`, async (t) => {
    const { make, fake, store, cleanupStore, scope } = setup(t);
    const release = cleanupStore.delete;
    const put = store.put;
    if (failure === "cleanup release")
      cleanupStore.delete = async () => {
        throw new Error(`${failure} failed`);
      };
    else
      store.put = async () => {
        throw new Error(`${failure} failed`);
      };
    fake.failTerminate(new Error("terminate outage"));
    await assert.rejects(make().provision(scope), new RegExp(`${failure} failed`));
    assert.deepEqual(await cleanupStore.get(scope), { resources: [{ sandboxId: "sbx-1" }] });
    assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
    assert.equal(await store.get(scope), null);
    cleanupStore.delete = release;
    store.put = put;
    fake.failTerminate();
    await make().reapDeepIdle!(0);
    assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
    assert.equal(await cleanupStore.get(scope), null);
    await make().provision(scope);
    assert.equal((await store.get(scope))!.sandboxId, "sbx-2");
    assert.equal(await cleanupStore.get(scope), null);
  });
}

test("Render names sandboxes for the deployment and terminates named sandboxes that no record tracks after a grace period", async (t) => {
  const { make, fake, scope, errors } = setup(t, { http: true });
  const sandbox = make();
  const computer = await sandbox.provision(scope);
  const disposable = await sandbox.provision(scope, { scratch: { key: "job" } });
  const name = fake.nameOf("sbx-1")!;
  assert.match(name, /^qm-default-org-/);
  assert.equal(fake.nameOf(disposable.providerSandboxId!), name);
  const orphans: string[] = [];
  for (let i = 0; i < 100; i++) orphans.push((await fake.client.create({ name, lifetimeSec: 3600 })).id);
  const otherDeployment = (await fake.client.create({ name: "qm-other-org-123456", lifetimeSec: 3600 })).id;

  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.ok(orphans.every((id) => fake.sandboxes.get(id)?.status === "running"));

  for (const id of fake.sandboxes.keys()) fake.age(id, 16 * 60_000);
  fake.failTerminate(new Error("terminate outage"), orphans[0]);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 99 });
  assert.ok(orphans.slice(1).every((id) => fake.sandboxes.get(id)?.status === "terminated"));
  assert.deepEqual(
    errors.filter((error) => error.code === "orphan_terminate_failed").map((error) => error.message),
    [`terminate orphan sandbox ${orphans[0]} <- Error: terminate outage`],
  );
  fake.failTerminate(undefined, orphans[0]);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get(orphans[0]!)?.status, "terminated");
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  assert.equal(fake.sandboxes.get(disposable.providerSandboxId!)?.status, "running");
  assert.equal(fake.sandboxes.get(otherDeployment)?.status, "running");
  await sandbox.teardown(disposable);
  await sandbox.teardown(computer);
});

test("Render names sandboxes alike on one database and leaves another database's sandboxes with the same org ID running", async (t) => {
  const { make, fake, client, scope, advisoryLock, blobTransfer } = setup(t, { http: true });
  await make().provision(scope);
  const other = createRenderSandbox({
    client,
    base: { ready: async () => ({ ref: BASE_REF, snapshotId: fake.seedGolden(BASE_REF) }), prepare: async () => {} },
    store: testMap<StoredRenderSandbox>(),
    scratchStore: testMap<StoredRenderScratch>(),
    cleanupStore: testMap<StoredRenderCleanup>(),
    advisoryLock,
    namespaceStore: testMap<StoredRenderNamespace>(),
    blobTransfer,
  });
  await other.provision(scopeId("personal", "other"));
  await make().provision(scopeId("personal", "second"));
  assert.equal(fake.nameOf("sbx-3"), fake.nameOf("sbx-1"));
  for (const id of fake.sandboxes.keys()) fake.age(id, 16 * 60_000);
  assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 0 });
  assert.deepEqual(await make().reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  assert.equal(fake.sandboxes.get("sbx-2")?.status, "running");
  assert.equal(fake.sandboxes.get("sbx-3")?.status, "running");
});

test("Render stops an idle computer when it cannot list its sandboxes", async (t) => {
  const { make, fake, store, scope, errors } = setup(t, {
    http: true,
    intercept: (request) =>
      request.method === "GET" && new URL(request.url).pathname === "/v1/sandboxes"
        ? Response.json({ message: "forbidden" }, { status: 403 })
        : undefined,
  });
  const sandbox = make();
  await sandbox.provision(scope);
  const { sandboxId } = (await store.get(scope))!;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  assert.equal(fake.sandboxes.get(sandboxId)?.status, "terminated");
  assert.deepEqual(
    errors.map((error) => error.code),
    ["orphan_list_failed"],
  );
});

test("Render checkpoints at teardown once per interval and skips an unused computer", async (t) => {
  const { make, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  const initial = (await store.get(scope))!.savedAtMs;
  await sandbox.writeFile(handle, "recent", "written within the interval");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.savedAtMs, initial);
  const stale = Date.now() - 6 * 60_000;
  await store.merge(scope, { savedAtMs: stale });
  await sandbox.teardown(handle, { keepWarm: true });
  assert.ok((await store.get(scope))!.savedAtMs! > stale);
  await store.merge(scope, { savedAtMs: stale });
  await sandbox.teardown(handle, { homeUnchanged: true });
  assert.equal((await store.get(scope))!.savedAtMs, stale);
  await sandbox.teardown(handle);
  assert.ok((await store.get(scope))!.savedAtMs! > stale);
});

test("Render replaces an idle computer near the end of its lifetime at turn start", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "kept", "work");
  const first = (await store.get(scope))!.sandboxId;
  fake.sandboxes.get(first)!.expiresAtMs = Date.now() + 60_000;
  const next = await sandbox.provision(scope);
  assert.notEqual((await store.get(scope))!.sandboxId, first);
  assert.equal(fake.sandboxes.get(first)?.status, "terminated");
  assert.equal(await sandbox.readFile(next, "kept"), "work");
});

test("Render tells a turn that its sandbox ended and restores it on the next turn", async (t) => {
  const { make, fake, store, scope, errors } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "kept", "work");
  await sandbox.reapDeepIdle!(0);
  const first = (await store.get(scope))!.sandboxId;
  await sandbox.provision(scope);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  await assert.rejects(sandbox.run(handle, "true"), /has stopped; the next turn restores it from its last checkpoint/);
  assert.equal((await store.get(scope))!.stopped, true);
  await store.merge(scope, { expiresAtMs: Date.now() - 1 });
  await sandbox.reapDeepIdle!(3600_000);
  const restored = await sandbox.provision(scope);
  assert.notEqual((await store.get(scope))!.sandboxId, first);
  assert.equal(await sandbox.readFile(restored, "kept"), "work");
  assert.deepEqual(
    errors.filter((error) => error.code === "computer_ended"),
    [],
  );
});

test("Render marks a computer that reached its lifetime stopped without reporting it as ended", async (t) => {
  const { make, fake, store, scope, errors } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await fake.client.terminate(stored.sandboxId);
  await store.merge(scope, { expiresAtMs: Date.now() - 1000 });
  await sandbox.reapDeepIdle!(3600_000);
  assert.equal((await store.get(scope))!.stopped, true);
  assert.deepEqual(
    errors.filter((error) => error.code === "computer_ended"),
    [],
  );
});

test("Render does not report a computer that QM itself restarted as ended", async (t) => {
  const { make, fake, store, scope, errors } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "kept", "work");
  const first = (await store.get(scope))!.sandboxId;
  await sandbox.restartComputer!(scope);
  assert.equal(fake.sandboxes.get(first)?.status, "terminated");
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000, homeDirty: true, savedAtMs: 0 });
  await sandbox.reapDeepIdle!(3600_000);
  assert.deepEqual(
    errors.filter((error) => error.code === "computer_ended"),
    [],
  );
  const restored = await sandbox.provision(scope);
  assert.equal(await sandbox.readFile(restored, "kept"), "work");
  assert.equal((await store.get(scope))!.stopped, undefined);
});

test("Render reports a computer that ended outside QM, probes it once, and leaves it alone until it is provisioned again", async (t) => {
  const { make, fake, store, scope, errors } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await fake.client.terminate(stored.sandboxId);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const get = t.mock.method(fake.client, "get");
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 1);
  assert.equal((await store.get(scope))!.stopped, true);
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 1);
  assert.deepEqual(errors, [{ code: "computer_ended", message: `Render sandbox ${stored.sandboxId} is terminated` }]);
  await sandbox.provision(scope);
  assert.equal((await store.get(scope))!.stopped, undefined);
});

test("Render reaper checkpoints changes a throttled teardown left behind", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  const initial = (await store.get(scope))!;
  await sandbox.writeFile(handle, "late", "written after the checkpoint");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.savedAtMs, initial.savedAtMs);
  assert.equal((await store.get(scope))!.homeDirty, true);
  const stale = Date.now() - 6 * 60_000;
  await store.merge(scope, { savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  const saved = (await store.get(scope))!;
  assert.ok(saved.savedAtMs! > stale);
  assert.equal(saved.homeDirty, false);
  assert.equal(fake.sandboxes.get(initial.sandboxId)?.status, "running");
  await store.merge(scope, { savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, stale);
});

test("Render backs up each interval of a detached process and its completed output", async (t) => {
  const { make, fake, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(scope);
  const initial = (await store.get(scope))!;
  await startBackgroundProcess(fake, initial.sandboxId);
  await sandbox.writeFile(handle, "foreground-output", "complete");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.savedAtMs, initial.savedAtMs);
  assert.equal((await store.get(scope))!.homeDirty, true);
  now += 6 * 60_000;
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, true);
  assert.equal(fake.sandboxes.get(initial.sandboxId)?.status, "running");
  await fake.client.writeFileBytes(initial.sandboxId, "/root/workspace/detached-output", Buffer.from("in progress"));
  now += 6 * 60_000;
  await sandbox.reapDeepIdle!(0);
  assert.equal((await store.get(scope))!.savedAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, true);
  await fake.client.writeFileBytes(initial.sandboxId, "/root/workspace/detached-output", Buffer.from("complete"));
  await finishBackgroundProcess(fake, initial.sandboxId);
  now += 6 * 60_000;
  await sandbox.reapDeepIdle!(0);
  assert.equal((await store.get(scope))!.savedAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, false);
  await fake.client.terminate(initial.sandboxId);
  const next = make();
  const restored = await next.provision(scope);
  assert.equal(await next.readFile(restored, "foreground-output"), "complete");
  assert.equal(await next.readFile(restored, "detached-output"), "complete");
});

test("Render keeps process reads available during a background checkpoint", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = fake.client.createSnapshot;
  t.mock.method(fake.client, "createSnapshot", async (id: string, name: string) => {
    const snapshot = await create(id, name);
    captured.resolve();
    await release.promise;
    return snapshot;
  });
  const checkpoint = sandbox.persistHomeSnapshot!(scope);
  await captured.promise;
  const reading = sandbox.listProcesses!(handle);
  try {
    const result = await Promise.race([reading, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000))]);
    assert.ok(result, "process reads waited for the checkpoint");
    assert.ok(result.some((process) => process.status.state === "running"));
  } finally {
    release.resolve();
    await Promise.all([checkpoint, reading]);
  }
  assert.equal((await store.get(scope))!.homeDirty, true);
});

for (const state of ["expired", "missing", "failed"] as const) {
  test(`Render refuses an empty replacement when its native snapshot is ${state}`, async (t) => {
    const { make, fake, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    await sandbox.writeFile(handle, "work", "retained");
    await sandbox.teardown(handle);
    const stored = (await store.get(scope))!;
    const snapshot = fake.snapshots.get(stored.checkpoint!.id)!;
    if (state === "expired") snapshot.expiresAtMs = Date.now() - 1;
    else if (state === "missing") await fake.client.deleteSnapshot(stored.checkpoint!);
    else snapshot.status = "failed";
    await fake.client.terminate(stored.sandboxId);
    await assert.rejects(make().provision(scope), /no available native snapshot/);
    assert.equal(fake.createdFrom.length, 1);
    assert.equal((await store.get(scope))!.sandboxId, stored.sandboxId);
  });
}

for (const operation of ["restart", "idle cleanup"] as const) {
  test(`Render keeps the current computer when a native snapshot fails during ${operation}`, async (t) => {
    const { make, fake, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    await sandbox.writeFile(handle, "work", "not saved yet");
    const stored = (await store.get(scope))!;
    fake.failCheckpoint(new Error("native snapshot outage"));
    if (operation === "restart") {
      await assert.rejects(sandbox.restartComputer!(scope), /native snapshot outage/);
    } else {
      await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
      assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
    }
    assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
    assert.equal(await sandbox.readFile(handle, "work"), "not saved yet");
    assert.equal((await store.get(scope))!.checkpoint?.id, stored.checkpoint!.id);
    assert.match((await sandbox.computerStatus!(scope)).recovery!.error!, /native snapshot outage/);
  });
}

test("Render restores its published native snapshot after the database reply is lost", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  const before = (await store.get(scope))!;
  await sandbox.writeFile(handle, "work", "published before reply loss");
  const merge = store.merge;
  let loseReply = true;
  t.mock.method(store, "merge", async (key: string, patch: Partial<StoredRenderSandbox>) => {
    const result = await merge(key, patch);
    if (patch.checkpoint && loseReply) {
      loseReply = false;
      throw new Error("checkpoint publication reply lost");
    }
    return result;
  });
  await assert.rejects(sandbox.persistHomeSnapshot!(scope), /checkpoint publication reply lost/);
  const published = (await store.get(scope))!;
  assert.notEqual(published.checkpoint!.id, before.checkpoint!.id);
  assert.equal(fake.snapshots.has(published.checkpoint!.id), true);
  assert.equal(fake.snapshots.has(before.checkpoint!.id), false);
  await fake.client.terminate(published.sandboxId);
  const next = make();
  const restored = await next.provision(scope);
  assert.equal(await next.readFile(restored, "work"), "published before reply loss");
});

test("Render restarts a computer from its checkpoint so the same turn keeps working", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "restart-marker.txt", "still here");
  const first = (await store.get(scope))!.sandboxId;
  await sandbox.restartComputer!(scope);
  const restarted = (await store.get(scope))!;
  assert.equal(fake.sandboxes.get(first)?.status, "terminated");
  assert.notEqual(restarted.sandboxId, first);
  assert.equal(restarted.stopped, undefined);
  assert.equal((await sandbox.run(handle, "cat restart-marker.txt")).stdout, "still here");
  assert.equal(computerVerdict(await sandbox.computerStatus!(scope)), "ok");
});

test("Render reports a stopped computer that has a checkpoint as paused without probing it", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  await sandbox.writeFile(handle, "kept", "work");
  await sandbox.teardown(handle);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 1 });
  const runScript = t.mock.method(fake.client, "runScript");
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.lifecycleState, "paused");
  assert.equal(status.provisioned, true);
  assert.equal(computerVerdict(status), "ok");
  assert.equal(runScript.mock.callCount(), 0);
  const restored = await sandbox.provision(scope);
  assert.equal(await sandbox.readFile(restored, "kept"), "work");
  assert.equal((await sandbox.computerStatus!(scope)).lifecycleState, "running");
});

test("Render reports a computer without a usable checkpoint as down, not paused", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(scope);
  const stored = (await store.get(scope))!;
  await fake.client.terminate(stored.sandboxId);
  await store.merge(scope, { checkpoint: { ...stored.checkpoint!, expiresAtMs: Date.now() - 1 } });
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.lifecycleState, undefined);
  assert.equal(computerVerdict(status), "down");
});

test(
  "Render returns a command that ignores TERM as a timeout with its partial output",
  { timeout: 60_000 },
  async (t) => {
    const { make, scope } = setup(t, { http: true });
    const sandbox = make();
    const handle = await sandbox.provision(scope);
    const started = Date.now();
    const hung = await sandbox.run(handle, "trap '' TERM; echo start; sleep 60; echo never", { timeoutMs: 1_000 });
    assert.equal(hung.timedOut, true);
    assert.equal(hung.stdout, "start\n");
    assert.ok(Date.now() - started < 15_000);
    assert.equal((await sandbox.run(handle, "echo alive")).stdout, "alive\n");
  },
);

test("Render does not report a command that exits 124 or 137 on its own as a timeout", async (t) => {
  const { make, scope } = setup(t, { http: true });
  const sandbox = make();
  const handle = await sandbox.provision(scope);
  for (const code of [124, 137]) {
    const result = await sandbox.run(handle, `exit ${code}`, { timeoutMs: 30_000 });
    assert.equal(result.code, code);
    assert.equal(result.timedOut, false);
  }
});
