import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { type ProcessRegistry, createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { writableMemoryScope } from "../src/memory/policy.ts";
import type { Sandbox, ProcessSession, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { ProcessSessionGoneError } from "../src/sandbox/exec-process-session.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };

function fakeProcessSandbox() {
  const procs = new Map<
    string,
    { command: string; output: string; exited: boolean; code: number; startedAt: number }
  >();
  const teardowns: Array<{ keepWarm: boolean }> = [];
  let authed = false;
  let n = 0;
  const sandbox: Sandbox = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: true,
    },
    async provision(): Promise<SandboxHandle> {
      return { id: "vm", rootDir: "/workspace", homeDir: "/root", resourceId: "sandbox-1" };
    },
    async run(_h, command) {
      if (/get-caller-identity|auth status|print-access-token/.test(command)) {
        return { stdout: authed ? "logged in" : "", stderr: "", code: authed ? 0 : 1, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async writeFileBytes() {},
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return [];
    },
    async removeDir() {},
    async startProcess(_h, command) {
      const processId = `00000000-0000-0000-0000-${(++n).toString(16).padStart(12, "0")}`;
      procs.set(processId, {
        command,
        output: "To authorize, open https://device.example/approve and enter code WXYZ-7788",
        exited: false,
        code: 0,
        startedAt: 1_000,
      });
      return { processId };
    },
    async readProcess(_h, id, opts) {
      const p = procs.get(id);
      if (!p) throw new ProcessSessionGoneError(id);
      const cur = opts?.sinceCursor ?? 0;
      return {
        chunks: p.output.slice(cur),
        cursor: p.output.length,
        status: p.exited ? { state: "exited", code: p.code } : { state: "running" },
      };
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses(): Promise<ProcessSession[]> {
      return [...procs.entries()].map(([processId, p]) => ({
        processId,
        command: p.command,
        startedAt: p.startedAt,
        status: p.exited ? { state: "exited", code: p.code } : { state: "running" },
      }));
    },
    async teardown(_h, opts) {
      teardowns.push({ keepWarm: opts?.keepWarm ?? false });
    },
  };
  return {
    sandbox,
    procs,
    teardowns,
    setAuthed: (v: boolean) => {
      authed = v;
    },
  };
}

function buildOrchestrator(processes: ProcessRegistry, sandbox: Sandbox) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "dps-")));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "dps-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    workspace,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 100, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy,
    acl,
    processes,
  });
}

async function memoryScope(): Promise<string> {
  const resolution = createResolutionService(
    ORG,
    testConfigStore(ORG),
    createAclStore(createPostgresGrantStore(testDatabaseUrl())),
  );
  return writableMemoryScope((await resolution.resolve(conv, actor)).layers, resolution.scopeFor(conv, actor));
}

const turn = (text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: conv,
  origin: { kind: "direct" },
  text,
});

test("a live durable process keeps the computer warm; none lets it suspend", async () => {
  const reg = createPostgresProcessRegistry(testDatabaseUrl());
  const fake = fakeProcessSandbox();
  const orch = buildOrchestrator(reg, fake.sandbox);

  const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };
  const live = await fake.sandbox.startProcess!(handle, "long build");
  await reg.register({
    processId: live.processId,
    scopeId: await memoryScope(),
    sandboxId: "sandbox-1",
    kind: "build",
    command: "long build",
    ttlMs: 600_000,
  });
  const res = await orch.handleTurn(turn("!run echo hi"));
  assert.equal(res.status, "ok");
  assert.equal(fake.teardowns.at(-1)!.keepWarm, true);

  fake.procs.get(live.processId)!.exited = true;
  await orch.handleTurn(turn("!run echo hi"));
  assert.equal(fake.teardowns.at(-1)!.keepWarm, false);
});

test("reattach reconciles a session whose process died while core was down", async () => {
  const reg = createPostgresProcessRegistry(testDatabaseUrl());
  const fake = fakeProcessSandbox();
  await reg.register({
    processId: "00000000-0000-0000-0000-0000000000ff",
    scopeId: await memoryScope(),
    sandboxId: "sandbox-1",
    kind: "build",
    command: "aws-sso: aws sso login",
    ttlMs: 600_000,
  });
  assert.equal((await reg.liveByScope(await memoryScope())).length, 1);

  const orch = buildOrchestrator(reg, fake.sandbox);
  await orch.handleTurn(turn("!run echo hi"));

  assert.equal((await reg.liveByScope(await memoryScope())).length, 0);
  assert.equal(fake.teardowns.at(-1)!.keepWarm, false);
});

test("with no live session the per-scope box suspends as before (gate is off by default)", async () => {
  const reg = createPostgresProcessRegistry(testDatabaseUrl());
  const fake = fakeProcessSandbox();
  const orch = buildOrchestrator(reg, fake.sandbox);
  await orch.handleTurn(turn("!run echo hello"));
  assert.equal(fake.teardowns.length, 1);
  assert.equal(fake.teardowns[0]!.keepWarm, false);
});
