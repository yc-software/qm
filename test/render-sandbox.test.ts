import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenderSandbox,
  type StoredRenderSandbox,
  type StoredRenderCleanup,
  type StoredRenderScratch,
} from "../src/sandbox/render-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createLocalBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import { supportsAgentComputerExport, supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { createSdkRenderClient } from "../src/sandbox/render-client.ts";
import { AWS_CLI_ENSURE } from "../src/sandbox/aws-cli.ts";
import { createSandboxResources } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { createFakeRender, serveFakeRenderApi } from "./support/fake-render.ts";
import { testMap, testAdvisoryLock } from "./support/test-database.ts";

function setup(
  t: TestContext,
  options: { http?: boolean; intercept?: (request: Request) => Response | undefined } = {},
) {
  const fake = createFakeRender();
  const http = options.http ? serveFakeRenderApi(t, fake, options.intercept) : undefined;
  const client = http ? createSdkRenderClient({ apiKey: "render-test-key", workspaceId: "tea-test" }) : fake.client;
  const dir = mkdtempSync(join(tmpdir(), "render-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const blobTransfer = createLocalBlobTransferStore(join(dir, "blobs"));
  const store = testMap<StoredRenderSandbox>();
  const scratchStore = testMap<StoredRenderScratch>();
  const cleanupStore = testMap<StoredRenderCleanup>();
  const advisoryLock = testAdvisoryLock();
  const errors: Array<{ code: string; message: string }> = [];
  const make = (checkpointIntervalMs = -1) =>
    createRenderSandbox(workspace, {
      client,
      store,
      scratchStore,
      cleanupStore,
      advisoryLock,
      blobTransfer,
      checkpointIntervalMs,
      onError: (error) => errors.push({ code: error.code, message: error.message }),
    });
  const scope = scopeId("personal", "tester");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  t.after(() => {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    fake,
    http,
    store,
    scratchStore,
    cleanupStore,
    make,
    scope,
    layers,
    blobTransfer,
    dir,
    workspace,
    advisoryLock,
    errors,
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
  const { make, http, layers } = setup(t, { http: true });
  const sandbox = make();
  const turnSecret = "turn-secret-8d1f";
  const processSecret = "process-secret-2c7a";
  const handle = await sandbox.provision(layers, { env: { QM_TURN_TOKEN: turnSecret } });
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
    assert.match(command, /^(timeout \d+ sh '\/dev\/\.qm-run\/[0-9a-f-]{36}\.sh'|test -f '[^']+')$/);
  }
});

test("Render resumes from its native checkpoint through transient API errors and sends a failed exec once", async (t) => {
  const failures: Array<{ method: string; path: RegExp; status: number }> = [];
  const injected: string[] = [];
  const { make, fake, http, layers, store, scope } = setup(t, {
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
  await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const checkpoint = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  failures.push(
    { method: "GET", path: new RegExp(`^/v1/sandboxes/${stored.sandboxId}$`), status: 503 },
    { method: "GET", path: new RegExp(`/snapshots/${checkpoint}$`), status: 429 },
  );
  const resumed = await sandbox.provision(layers);
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

test("Render declares the computer that its base image provides and its sandbox lifetime", (t) => {
  const { make } = setup(t);
  const { spec } = make().profile;
  assert.match(spec?.os ?? "", /at most 24 hours/);
  assert.match(spec?.os ?? "", /background processes stop when a sandbox ends/);
  assert.deepEqual(spec?.runtimes, ["Node 24", "Python 3"]);
  for (const tool of ["git", "curl", "jq", "tar", "python3", "aws"]) assert.ok(spec?.tools?.includes(tool), tool);
  for (const tool of ["gh", "gcloud", "kubectl", "flyctl", "glab"]) assert.ok(spec?.notInstalled?.includes(tool), tool);
  assert.deepEqual([spec?.cpus, spec?.memoryMb, spec?.diskGb], [2, 4096, 10]);
});

test("Render starts a sandbox and reports the failure when the AWS CLI cannot be installed", async (t) => {
  const { make, fake, layers, errors } = setup(t);
  const runScript = fake.client.runScript;
  t.mock.method(fake.client, "runScript", async (id: string, script: string, timeoutSec: number) =>
    script === AWS_CLI_ENSURE
      ? { stdout: "downloading", stderr: "curl: (6) Could not resolve host", exitCode: 6 }
      : runScript(id, script, timeoutSec),
  );
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  assert.equal((await sandbox.run(handle, "echo ready")).stdout, "ready\n");
  assert.ok(
    errors.some(
      (error) =>
        error.code === "aws_cli_install_failed" &&
        error.message.endsWith("(exit 6): curl: (6) Could not resolve host downloading"),
    ),
  );
});

test("Render installs the AWS CLI on every sandbox it starts, including restores and disposable ones", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  await sandbox.provision(layers);
  await sandbox.provision(layers, { scratch: { key: "build" } });
  assert.equal(fake.commands.filter((command) => command === AWS_CLI_ENSURE).length, 3);
});

test("Render provisions one durable sandbox across two cores and executes in its workspace", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const first = make();
  const second = make();
  const [a, b] = await Promise.all([
    first.provision(layers, { env: { QM_TEST_VALUE: "hello" } }),
    second.provision(layers),
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
  const { make, fake, layers, store, scope } = setup(t);
  const first = make();
  const handle = await first.provision(layers);
  await first.writeFile(handle, "nested/work.txt", "retained");
  await first.teardown(handle);
  const stored = (await store.get(scope))!;
  const checkpointId = stored.checkpoint!.id;
  await fake.client.terminate(stored.sandboxId);
  const second = make();
  const restored = await second.provision(layers);
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
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
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
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "kept", "before suspension");
  await sandbox.teardown(handle);
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.status = "suspended";
  const restored = await make().provision(layers);
  assert.equal(restored.coldStart, false);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
  assert.equal(fake.createdFrom[1], stored.checkpoint!.id);
  assert.equal(await sandbox.readFile(restored, "kept"), "before suspension");
});

test("Render refuses an empty replacement for an existing sandbox without a snapshot", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  await make().provision(layers);
  const stored = (await store.get(scope))!;
  await store.put(scope, { sandboxId: stored.sandboxId, expiresAtMs: stored.expiresAtMs, lastActivityMs: 0 });
  await fake.client.terminate(stored.sandboxId);
  await assert.rejects(make().provision(layers), /no available native snapshot/);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal((await store.get(scope))!.sandboxId, stored.sandboxId);
});

function blockCommands(fake: ReturnType<typeof createFakeRender>) {
  const gate = Promise.withResolvers<void>();
  const run = fake.client.runScript;
  fake.client.runScript = async (id, script, timeoutSec) => {
    if (script.includes("blocked-command")) await gate.promise;
    return run(id, script, timeoutSec);
  };
  return gate;
}

test(
  "Render lets other turns provision, tear down, and checkpoint during a command and restarts after it ends",
  { timeout: 60_000 },
  async (t) => {
    const { make, fake, layers, store, scope, advisoryLock } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(layers);
    const gate = blockCommands(fake);
    const blocked = sandbox.run(handle, "echo blocked-command");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await advisoryLock.tryWithLock!(`render-sandbox-use:${handle.id}`, async () => true), null);
    assert.equal((await sandbox.run(handle, "echo concurrent")).stdout, "concurrent\n");
    const before = (await store.get(scope))!;
    const other = make();
    const second = await other.provision(layers);
    await other.writeFile(second, "second-turn", "saved");
    await other.teardown(second);
    assert.equal((await store.get(scope))!.homeDirty, true);
    await sandbox.persistHomeSnapshot!(scope);
    assert.notEqual((await store.get(scope))!.checkpoint!.id, before.checkpoint!.id);
    let restarted = false;
    const restarting = sandbox.restartComputer!(scope).then(() => {
      restarted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(restarted, false);
    assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
    gate.resolve();
    assert.equal((await blocked).stdout, "blocked-command\n");
    await restarting;
    assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
    assert.equal((await store.get(scope))!.homeDirty, false);
    const restored = await make().provision(layers);
    assert.equal(await sandbox.readFile(restored, "second-turn"), "saved");
  },
);

test("Render turns share one computer through the sandbox router", { timeout: 60_000 }, async (t) => {
  const { make, fake, layers, scope, advisoryLock } = setup(t);
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
  const first = await router.provision(layers);
  assert.equal(first.resourceId, record.id);
  const gate = blockCommands(fake);
  const blocked = router.run(first, "echo blocked-command");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await router.provision(layers);
  assert.equal((await router.run(second, "echo concurrent")).stdout, "concurrent\n");
  await router.teardown(second);
  gate.resolve();
  assert.equal((await blocked).stdout, "blocked-command\n");
  await router.teardown(first);
});

test("Render reaping keeps a sandbox whose background process starts after the first process probe", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  const expiresAtMs = Date.now() + 60_000;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  await store.merge(scope, { expiresAtMs });
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

test("Render keeps an expiring sandbox that another turn is using and rotates it after the command", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 60_000;
  const gate = blockCommands(fake);
  const blocked = sandbox.run(handle, "echo blocked-command");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await make().provision(layers);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  gate.resolve();
  await blocked;
  await make().provision(layers);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render rotates a sandbox near expiry only after it saves a new checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "new", "latest");
  const stored = (await store.get(scope))!;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 60_000;
  const rotated = await make().provision(layers);
  assert.equal(rotated.coldStart, false);
  assert.equal(await sandbox.readFile(rotated, "new"), "latest");
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render scratch sandboxes are shared only until the last handle is released", async (t) => {
  const { make, fake, layers, store } = setup(t);
  const sandbox = make();
  const a = await sandbox.provision(layers, { scratch: { key: "job" } });
  const b = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(fake.createdFrom.length, 1);
  assert.equal((await store.entries()).length, 0);
  await sandbox.teardown(a);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "running");
  await sandbox.teardown(b);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
  assert.equal(fake.snapshots.size, 0);
});

test("Render destroys both the sandbox and its checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(await store.get(scope), null);
  assert.equal(fake.snapshots.size, 0);
  assert.equal(fake.sandboxes.get("sbx-1")?.status, "terminated");
});

test("Render does not replay a command when an exec call fails", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  await assert.rejects(sandbox.run(handle, "side-effect"), /no longer running/);
  assert.equal(fake.createdFrom.length, 1);
});

test("Render clears expired temporary credentials after a native restore", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  const handle = await source.provision(layers);
  await fake.client.writeFileBytes(
    (await store.get(scope))!.sandboxId,
    "/root/.cred-state-secret",
    Buffer.from("expired"),
  );
  await source.teardown(handle);
  await fake.client.terminate((await store.get(scope))!.sandboxId);
  const target = make();
  await target.provision(layers);
  assert.equal(await fake.client.readFileBytes((await store.get(scope))!.sandboxId, "/root/.cred-state-secret"), null);
});

test("Render keeps a running process during monitor provisioning near sandbox expiry", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const source = make();
  await source.provision(layers);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 650_000;
  const monitor = make();
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 1);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  await finishBackgroundProcess(fake, stored.sandboxId);
  await monitor.provision(layers);
  assert.equal(fake.createdFrom.length, 2);
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
});

test("Render disposes a new native checkpoint when its staging record write fails", async (t) => {
  const { make, fake, store, scope } = setup(t);
  const info = await fake.client.create();
  await store.put(scope, {
    sandboxId: info.id,
    expiresAtMs: info.expiresAtMs,
    lastActivityMs: Date.now(),
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
  const { make, fake, layers, store, scope, errors } = setup(t);
  const create = fake.client.createSnapshot;
  fake.client.createSnapshot = async (id, name) => {
    const saved = fake.snapshots.get((await create(id, name)).id)!;
    saved.status = "failed";
    saved.error = "Provider: insufficient snapshot capacity";
    return { ...saved };
  };
  await assert.rejects(make().provision(layers), /insufficient snapshot capacity/);
  assert.match((await store.get(scope))!.recoveryError!, /insufficient snapshot capacity/);
  assert.ok(
    errors.some(
      ({ code, message }) => code === "native_checkpoint_failed" && message.includes("insufficient snapshot capacity"),
    ),
  );
});

test("Render finishes a destroy that stopped after it wrote the cleanup record", async (t) => {
  const { make, fake, layers, store, scope, cleanupStore } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.teardown(handle);
  const before = (await store.get(scope))!;
  await cleanupStore.put(scope, {
    resources: [{ sandboxId: before.sandboxId, checkpoint: before.checkpoint }],
  });
  const replacement = await make().provision(layers);
  assert.equal(replacement.coldStart, true);
  assert.equal(await cleanupStore.get(scope), null);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "terminated");
  assert.equal(fake.snapshots.has(before.checkpoint!.id), false);
  assert.notEqual((await store.get(scope))!.sandboxId, before.sandboxId);
});

test("Render removes a destroyed scope at once and deletes a retired checkpoint that is still being created later", async (t) => {
  const { make, fake, layers, store, scope, cleanupStore } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
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
  const replacement = await make().provision(layers);
  assert.equal(replacement.coldStart, true);
  fake.snapshots.get(stray.id)!.status = "available";
  await make().reapDeepIdle!(3600_000);
  assert.equal(await cleanupStore.get(scope), null);
  assert.equal(fake.snapshots.has(stray.id), false);
});
test("Render checkpoints background changes before TTL even when idle reaping is disabled", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "background", "retained output");
  const expiresAtMs = Date.now() + 16 * 60_000;
  const stale = Date.now() - 360_000;
  await store.merge(scope, { savedAtMs: stale, expiresAtMs });
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
  const checkpointAtMs = (await store.get(scope))!.savedAtMs!;
  assert.ok(checkpointAtMs > stale);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, checkpointAtMs);
  await fake.client.terminate(stored.sandboxId);
  const other = make();
  const restored = await other.provision(layers);
  assert.equal(await other.readFile(restored, "background"), "retained output");
});

for (const operation of ["file import", "provision preparation"] as const) {
  test(
    `Render completes ${operation} before another core checkpoints and expires its sandbox`,
    { timeout: 60_000 },
    async (t) => {
      const { make, fake, layers, store, scope, workspace, advisoryLock } = setup(t);
      const sandbox = make();
      const other = make();
      const handle = await sandbox.provision(layers);
      const stored = (await store.get(scope))!;
      const layerScope = scopeId("personal", "reference");
      await workspace.write(layerScope, "latest", "completed operation");
      const uploading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const archivePath = operation === "file import" ? /\/\.extract-[^/]+\.tar$/ : /\/\.ro-layers\.tar$/;
      const write = fake.client.writeFileBytes;
      fake.client.writeFileBytes = async (id, path, data) => {
        await write(id, path, data);
        if (archivePath.test(path)) {
          uploading.resolve();
          await release.promise;
        }
      };
      const pending =
        operation === "file import"
          ? sandbox.importFiles!(handle, [{ path: "latest", data: Buffer.from("completed operation") }])
          : sandbox.provision([...layers, { scopeId: layerScope, mountPath: "", mode: "ro" }]);
      await uploading.promise;
      const expiresAtMs = Date.now() + 60_000;
      fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
      await store.merge(scope, { expiresAtMs });
      try {
        const key = operation === "file import" ? `render-sandbox-use:${handle.id}` : `render-sandbox:${handle.id}`;
        assert.equal(await advisoryLock.tryWithLock!(key, async () => true), null);
        assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 0 });
        assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "running");
      } finally {
        release.resolve();
        await pending;
      }
      assert.deepEqual(await other.reapDeepIdle!(0), { reaped: 1 });
      assert.equal(fake.sandboxes.get(stored.sandboxId)?.status, "terminated");
      const restored = await other.provision(layers);
      assert.equal(await other.readFile(restored, "latest"), "completed operation");
    },
  );
}

test("Render skips remote probes and checkpoints for a recently used sandbox", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  await store.merge(scope, { savedAtMs: Date.now() - 360_000 });
  const before = (await store.get(scope))!;
  const get = t.mock.method(fake.client, "get");
  const commands = fake.commands.length;
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(fake.commands.length, commands);
  assert.equal((await store.get(scope))!.savedAtMs, before.savedAtMs);
  await make().provision(layers);
  assert.ok(fake.commands.slice(commands).every((command) => !command.includes(".agent-proc")));
  assert.equal((await store.get(scope))!.savedAtMs, before.savedAtMs);
});

test("Render leaves an idle sandbox with a running process alone until its TTL is near", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  const before = (await store.get(scope))!;
  await startBackgroundProcess(fake, before.sandboxId);
  const stale = Date.now() - 360_000;
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000, savedAtMs: stale });
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, stale);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
});

test("Render records command and file activity without a write for each operation", async (t) => {
  const { make, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
  await store.merge(scope, { lastActivityMs: now - 7200_000 });
  const merge = t.mock.method(store, "merge");
  await sandbox.run(handle, "true");
  await sandbox.writeFile(handle, "activity", "retained");
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(merge.mock.callCount(), 1);
  assert.deepEqual(await make(5 * 60_000).reapDeepIdle!(3600_000), { reaped: 0 });
  now += 60_000;
  assert.equal(await sandbox.readFile(handle, "activity"), "retained");
  assert.equal((await store.get(scope))!.lastActivityMs, now);
  assert.equal(merge.mock.callCount(), 2);
});

for (const operation of ["command", "upload"]) {
  test(`Render recovers ${operation} work after core restart without teardown`, async (t) => {
    const { make, fake, layers, store, scope } = setup(t);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const sandbox = make(5 * 60_000);
    const handle = await sandbox.provision(layers);
    if (operation === "command") await sandbox.run(handle, "printf retained > crash-work");
    else await sandbox.writeFileBytes(handle, "crash-work", Buffer.from("retained"));
    now += 6 * 60_000;
    const next = make(5 * 60_000);
    assert.deepEqual(await next.reapDeepIdle!(0), { reaped: 0 });
    await fake.client.terminate((await store.get(scope))!.sandboxId);
    const restored = await next.provision(layers);
    assert.equal(await next.readFile(restored, "crash-work"), "retained");
  });
}

test("Render preserves a write that arrives during native snapshot capture", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
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
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "after-capture"), "retained");
});
test("Render rechecks activity after it waits for a sandbox operation", async (t) => {
  const { make, fake, layers, store, scope, advisoryLock } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await store.merge(scope, { lastActivityMs: Date.now() - 7200_000 });
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = advisoryLock.withLock(`render-sandbox:${handle.id}`, async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const listed = Promise.withResolvers<void>();
  const entries = store.entries;
  t.mock.method(store, "entries", async () => {
    const result = await entries();
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

test("Render saves a home before the rotation window without stopping its sandbox", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
  await sandbox.writeFile(handle, "latest", "retained before rotation");
  const before = (await store.get(scope))!;
  const expiresAtMs = Date.now() + 16 * 60_000;
  fake.sandboxes.get(before.sandboxId)!.expiresAtMs = expiresAtMs;
  const stale = Date.now() - 360_000;
  await store.merge(scope, { savedAtMs: stale, expiresAtMs });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.ok((await store.get(scope))!.savedAtMs! > stale);
  assert.equal(fake.sandboxes.get(before.sandboxId)?.status, "running");
  const rotationExpiresAtMs = Date.now() + 10 * 60_000;
  fake.sandboxes.get(before.sandboxId)!.expiresAtMs = rotationExpiresAtMs;
  await store.merge(scope, { expiresAtMs: rotationExpiresAtMs });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 1 });
  const next = make();
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "latest"), "retained before rotation");
});

test("Render checkpoints at teardown once per interval and skips an unused computer", async (t) => {
  const { make, layers, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
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

test("Render leaves scopes whose sandbox already expired alone until they are provisioned again", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  await sandbox.provision(layers);
  await store.merge(scope, { expiresAtMs: Date.now() - 1, lastActivityMs: Date.now() - 7200_000 });
  const get = t.mock.method(fake.client, "get");
  assert.deepEqual(await sandbox.reapDeepIdle!(3600_000), { reaped: 0 });
  assert.equal(get.mock.callCount(), 0);
});

test("Render reaper checkpoints changes a throttled teardown left behind", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
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

test("Render saves completed work after a recent checkpoint near sandbox expiry", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
  const stored = (await store.get(scope))!;
  await startBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "final-output", "in progress");
  const expiresAtMs = now + 4 * 60_000;
  fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = expiresAtMs;
  await store.merge(scope, { expiresAtMs, savedAtMs: now - 6 * 60_000 });
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  assert.equal((await store.get(scope))!.savedAtMs, now);
  now += 60_000;
  await finishBackgroundProcess(fake, stored.sandboxId);
  await sandbox.writeFile(handle, "final-output", "complete");
  await sandbox.teardown(handle, { keepWarm: true });
  assert.equal((await store.get(scope))!.savedAtMs, now);
  assert.equal((await store.get(scope))!.homeDirty, false);
  now = expiresAtMs + 1;
  await fake.client.terminate(stored.sandboxId);
  assert.deepEqual(await sandbox.reapDeepIdle!(0), { reaped: 0 });
  const next = make();
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "final-output"), "complete");
});

test("Render backs up each interval of a detached process and its completed output", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sandbox = make(5 * 60_000);
  const handle = await sandbox.provision(layers);
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
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "foreground-output"), "complete");
  assert.equal(await next.readFile(restored, "detached-output"), "complete");
});

test("Render keeps process reads available during a background checkpoint", async (t) => {
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
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
    const { make, fake, layers, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(layers);
    await sandbox.writeFile(handle, "work", "retained");
    await sandbox.teardown(handle);
    const stored = (await store.get(scope))!;
    const snapshot = fake.snapshots.get(stored.checkpoint!.id)!;
    if (state === "expired") snapshot.expiresAtMs = Date.now() - 1;
    else if (state === "missing") await fake.client.deleteSnapshot(stored.checkpoint!);
    else snapshot.status = "failed";
    await fake.client.terminate(stored.sandboxId);
    await assert.rejects(make().provision(layers), /no available native snapshot/);
    assert.equal(fake.createdFrom.length, 1);
    assert.equal((await store.get(scope))!.sandboxId, stored.sandboxId);
  });
}

for (const operation of ["restart", "rotation", "idle cleanup"] as const) {
  test(`Render keeps the current computer when a native snapshot fails during ${operation}`, async (t) => {
    const { make, fake, layers, store, scope } = setup(t);
    const sandbox = make();
    const handle = await sandbox.provision(layers);
    await sandbox.writeFile(handle, "work", "not saved yet");
    const stored = (await store.get(scope))!;
    fake.failCheckpoint(new Error("native snapshot outage"));
    if (operation === "restart") {
      await assert.rejects(sandbox.restartComputer!(scope), /native snapshot outage/);
    } else if (operation === "rotation") {
      fake.sandboxes.get(stored.sandboxId)!.expiresAtMs = Date.now() + 60_000;
      await assert.rejects(make().provision(layers), /native snapshot outage/);
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
  const { make, fake, layers, store, scope } = setup(t);
  const sandbox = make();
  const handle = await sandbox.provision(layers);
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
  const restored = await next.provision(layers);
  assert.equal(await next.readFile(restored, "work"), "published before reply loss");
});
