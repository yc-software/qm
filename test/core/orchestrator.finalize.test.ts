import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { createMockHarness } from "../support/mock-harness.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import type { Sandbox, SandboxHandle, TeardownOptions } from "../../src/sandbox/sandbox.ts";
import type { ErrorLog } from "../../src/admin/error-log.ts";
import type { SurfaceCache } from "../../src/surface-cache/types.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

const actor: Principal = { id: "U1", type: "internal" };
const dm = (thread: string, text: string): Omit<OrchestratorInput, "background"> => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  origin: { kind: "direct" },
  text,
});

const tick = () => new Promise((r) => setTimeout(r, 5));

function gatedSandbox() {
  const handle: SandboxHandle = { id: "vm1", rootDir: "/workspace", homeDir: "/root", coldStart: false };
  let provisioned = 0;
  let teardownStarted = 0;
  let teardownFinished = 0;
  const teardownOpts: Array<TeardownOptions | undefined> = [];
  const gates: Array<() => void> = [];
  const noop = async () => {};
  const sandbox = {
    profile: {
      backend: "fake",
      isolation: "microvm",
      lifetime: "per_scope",
      writablePersistence: "resident_disk",
      homePersistence: "resident_disk",
      egress: "provider_governed",
      auth: "resident_machine",
      processSessions: false,
    },
    async provision() {
      provisioned++;
      return handle;
    },
    async run(_h: SandboxHandle, command: string) {
      return { stdout: `ran:${command}`, stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    writeFile: noop,
    writeFileBytes: noop,
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return [];
    },
    removeDir: noop,
    async teardown(_h: SandboxHandle, opts?: TeardownOptions) {
      teardownStarted++;
      teardownOpts.push(opts);
      await new Promise<void>((res) => gates.push(res));
      teardownFinished++;
    },
  } as unknown as Sandbox;
  return {
    sandbox,
    teardownOpts,
    release: () => gates.shift()?.(),
    get provisioned() {
      return provisioned;
    },
    get teardownStarted() {
      return teardownStarted;
    },
    get teardownFinished() {
      return teardownFinished;
    },
  };
}

function buildOrchestrator(
  sandbox: Sandbox,
  errors?: ErrorLog,
  harness = createMockHarness(),
  surfaceCache?: SurfaceCache,
) {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "frr-")));
  const sessions = createPostgresSessionStore(databaseUrl);
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "frr-deploy"),
    auditLog,
    acl,
  });
  const orch = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(config, acl),
    sessions,
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(databaseUrl),
    deploy,
    acl,
    ...(errors ? { errors } : {}),
    ...(surfaceCache ? { surfaceCache } : {}),
  });
  return { orch, sessions };
}

test("background: the run finishes as soon as the reply is ready; backup/teardown run detached + the lease is freed early", async () => {
  const g = gatedSandbox();
  const { orch, sessions } = buildOrchestrator(g.sandbox);

  const result = await orch.handleTurn({ ...dm("dm:U1:t1", "!run echo hi"), runId: "r1", background: true });
  assert.equal(result.status, "ok");
  assert.equal(g.provisioned, 1, "the turn provisioned a box");

  assert.equal(g.teardownFinished, 0, "the VM was NOT torn down before the reply returned");

  const { lease: lease2 } = await sessions.acquireLease(result.sessionId!);
  assert.ok(lease2, "the session lease is free right after the reply (fast follow-up not blocked)");
  await sessions.releaseLease(lease2!);

  for (let i = 0; i < 2000 && g.teardownStarted === 0; i++) await tick();
  assert.equal(g.teardownStarted, 1, "the detached tail reached teardown");
  assert.equal(g.teardownFinished, 0, "...and it ran AFTER the reply returned (still gated here)");
  g.release();
  for (let i = 0; i < 2000 && g.teardownFinished === 0; i++) await tick();
  assert.equal(g.teardownFinished, 1, "the detached tail completed once unblocked");
});

test("background: title persistence finishes before the run while teardown stays detached", async () => {
  const g = gatedSandbox();
  const base = createMockHarness();
  const harness = { ...base, models: { ...base.models, generateTitle: () => new Promise<string>(() => {}) } };
  const { orch, sessions } = buildOrchestrator(g.sandbox, undefined, harness);
  const result = await orch.handleTurn({
    ...dm("dm:U1:title-background", "!run echo hi"),
    displayText: "Simulate four-way title outage from the visible message",
    runId: "title-background",
    background: true,
  });

  assert.equal(result.status, "ok");
  assert.equal(
    (await sessions.get(result.sessionId!))?.title,
    "Simulate four-way title outage from the visible message",
  );
  assert.equal(g.teardownFinished, 0);
  for (let i = 0; i < 2000 && g.teardownStarted === 0; i++) await tick();
  g.release();
});

test("spine-routed titles use visible text instead of the internal wake envelope", async () => {
  const { orch, sessions } = buildOrchestrator(gatedSandbox().sandbox);
  const result = await orch.handleTurn({
    ...dm(
      "dm:U1:title-spine",
      '<wake reason="addressed">Simulate four-way title outage from the internal envelope</wake>',
    ),
    displayText: "Simulate four-way title outage from the visible message",
    runId: "title-spine",
    background: true,
  });

  assert.equal(
    (await sessions.get(result.sessionId!))?.title,
    "Simulate four-way title outage from the visible message",
  );
  assert.equal(
    (await orch.regenerateTitle(result.sessionId!, actor.id))?.title,
    "Simulate four-way title outage from the visible message",
  );
});

test("background: a turn that never used its eagerly provisioned box returns before teardown and marks the home unchanged", async () => {
  const g = gatedSandbox();
  const { orch } = buildOrchestrator(g.sandbox, undefined, createMockHarness());

  const first = await orch.handleTurn({ ...dm("dm:U1:t4", "!run echo hi"), runId: "r4", background: true });
  assert.equal(first.status, "ok");
  for (let i = 0; i < 2000 && g.teardownStarted === 0; i++) await tick();
  g.release();
  for (let i = 0; i < 2000 && g.teardownFinished === 0; i++) await tick();
  assert.equal(g.provisioned, 1);

  const second = await orch.handleTurn({ ...dm("dm:U1:t4", "just chatting"), runId: "r5", background: true });
  assert.equal(second.status, "ok");
  assert.equal(g.provisioned, 2, "the session had used tools before, so the box was provisioned eagerly");
  assert.equal(g.teardownFinished, 1, "the reply returned without waiting for the unused box's teardown");

  for (let i = 0; i < 2000 && g.teardownStarted < 2; i++) await tick();
  assert.equal(g.teardownStarted, 2, "the detached tail reached teardown");
  assert.equal(g.teardownOpts[1]?.homeUnchanged, true, "an unused box tells the backend there is nothing to snapshot");
  assert.equal(g.teardownOpts[0]?.homeUnchanged, undefined, "a used box does not");
  g.release();
  for (let i = 0; i < 2000 && g.teardownFinished < 2; i++) await tick();
  assert.equal(g.teardownFinished, 2);
});

test("background: a turn paused on approval returns its card before the eagerly provisioned box is torn down", async () => {
  const g = gatedSandbox();
  const { orch, sessions } = buildOrchestrator(g.sandbox, undefined, createMockHarness());

  const first = await orch.handleTurn({ ...dm("dm:U1:t7", "!run echo hi"), runId: "r7", background: true });
  assert.equal(first.status, "ok");
  for (let i = 0; i < 200 && g.teardownStarted === 0; i++) await tick();
  g.release();
  for (let i = 0; i < 200 && g.teardownFinished === 0; i++) await tick();

  const turn = orch.handleTurn({ ...dm("dm:U1:t7", "!finish-silent-paused"), runId: "r8", background: true });
  const paused = await Promise.race([turn, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))]);
  assert.ok(paused, "the paused turn returned while the teardown was still gated");
  assert.equal(paused.status, "pending_approval");
  assert.equal(paused.pendingApprovals?.length, 1);
  assert.equal(g.provisioned, 2, "the box was provisioned eagerly for the paused turn");
  assert.equal(g.teardownFinished, 1, "the approval card returned without waiting for that box's teardown");

  const { lease } = await sessions.acquireLease(paused.sessionId!);
  assert.ok(lease, "the resumed turn can claim the session while the box is still being reclaimed");
  await sessions.releaseLease(lease!);

  for (let i = 0; i < 200 && g.teardownStarted < 2; i++) await tick();
  assert.equal(g.teardownStarted, 2, "the detached tail still reclaims the box");
  g.release();
  for (let i = 0; i < 200 && g.teardownFinished < 2; i++) await tick();
  assert.equal(g.teardownFinished, 2);
});

test("background: the message edit catch-up still runs before the lease is released", async () => {
  const g = gatedSandbox();
  let asked = 0;
  const surfaceCache = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) =>
      prop === "revisedSince"
        ? async () => {
            asked++;
            return [];
          }
        : async () => [],
  }) as unknown as SurfaceCache;
  const { orch } = buildOrchestrator(g.sandbox, undefined, createMockHarness(), surfaceCache);
  const result = await orch.handleTurn({
    ...dm("ch:C1:t1", "!run echo hi"),
    surface: "slack",
    conversation: { kind: "channel", threadRef: "ch:C1:t1", audience: [actor] } as Conversation,
    runId: "r6",
    background: true,
  });
  assert.equal(result.status, "ok");
  assert.equal(asked, 1, "the edit catch-up ran even though the tail was detached");
  assert.equal(g.teardownFinished, 0);
  g.release();
});

test("background: an error in the detached tail still reclaims the box (no machine refcount leak)", async () => {
  const handle: SandboxHandle = { id: "vm-err", rootDir: "/workspace", homeDir: "/root", coldStart: false };
  let teardowns = 0;
  const noop = async () => {};
  const sandbox = {
    profile: {
      backend: "fake",
      isolation: "microvm",
      lifetime: "per_scope",
      writablePersistence: "resident_disk",
      homePersistence: "resident_disk",
      egress: "provider_governed",
      auth: "resident_machine",
      processSessions: false,
    },
    async provision() {
      return handle;
    },
    async run(_h: SandboxHandle, command: string) {
      return { stdout: `ran:${command}`, stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    writeFile: noop,
    writeFileBytes: noop,
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return [];
    },
    removeDir: noop,
    async teardown() {
      teardowns++;
    },
  } as unknown as Sandbox;
  const throwingErrors: ErrorLog = {
    record() {
      throw new Error("error log unavailable");
    },
    flush: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
  };
  const harness = createMockHarness();
  harness.models.generateTitle = async () => {
    throw new Error("title gen blew up");
  };
  const { orch } = buildOrchestrator(sandbox, throwingErrors, harness);

  const result = await orch.handleTurn({ ...dm("dm:U1:t3", "!run echo hi"), runId: "r3", background: true });
  assert.equal(result.status, "ok");

  for (let i = 0; i < 2000 && teardowns === 0; i++) await tick();
  assert.equal(teardowns, 1, "the box is reclaimed even though the tail failed");
});

test("blocking path: the turn does NOT return until the tail (teardown) completes", async () => {
  const g = gatedSandbox();
  const { orch } = buildOrchestrator(g.sandbox);

  const p = orch.handleTurn({ ...dm("dm:U1:t2", "!run echo hi"), runId: "r2" });
  let done = false;
  void p.then(() => {
    done = true;
  });

  for (let i = 0; i < 2000 && g.teardownStarted === 0; i++) await tick();
  assert.equal(g.teardownStarted, 1, "the blocking path runs the tail (reaches teardown)");
  assert.equal(done, false, "handleTurn has NOT returned — it awaits the tail");

  g.release();
  const result = await p;
  assert.equal(result.status, "ok");
  assert.equal(g.teardownFinished, 1, "the tail completed before the blocking turn returned");
});
