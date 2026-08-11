import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { ErrorLog } from "../src/admin/error-log.ts";
import type { Conversation, Principal } from "../src/types.ts";

const ORG = "default-org";
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
    async teardown() {
      teardownStarted++;
      await new Promise<void>((res) => gates.push(res));
      teardownFinished++;
    },
  } as unknown as Sandbox;
  return {
    sandbox,
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

function buildOrchestrator(sandbox: Sandbox, errors?: ErrorLog, harness = createMockHarness()) {
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "frr-")));
  const sessions = createMemorySessionStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "frr-deploy"),
    auditLog,
    acl,
  });
  const orch = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy,
    acl,
    ...(errors ? { errors } : {}),
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

  for (let i = 0; i < 200 && g.teardownStarted === 0; i++) await tick();
  assert.equal(g.teardownStarted, 1, "the detached tail reached teardown");
  assert.equal(g.teardownFinished, 0, "...and it ran AFTER the reply returned (still gated here)");
  g.release();
  for (let i = 0; i < 200 && g.teardownFinished === 0; i++) await tick();
  assert.equal(g.teardownFinished, 1, "the detached tail completed once unblocked");
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

  for (let i = 0; i < 200 && teardowns === 0; i++) await tick();
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

  for (let i = 0; i < 200 && g.teardownStarted === 0; i++) await tick();
  assert.equal(g.teardownStarted, 1, "the blocking path runs the tail (reaches teardown)");
  assert.equal(done, false, "handleTurn has NOT returned — it awaits the tail");

  g.release();
  const result = await p;
  assert.equal(result.status, "ok");
  assert.equal(g.teardownFinished, 1, "the tail completed before the blocking turn returned");
});
