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
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createMemoryProcessRegistry, type ProcessRegistry } from "../src/processes/process-registry.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { writableMemoryScope } from "../src/memory/policy.ts";
import type { Sandbox, ProcessSession, SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";

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
      return { id: "vm", rootDir: "/workspace", homeDir: "/root" };
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
      if (!p) throw new Error(`no such process session: ${id}`);
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
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "dps-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "dps-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createMemorySessionStore(),
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory: createMemoryService(workspace),
    deploy,
    acl,
    processes,
  });
}

async function memoryScope(): Promise<string> {
  const resolution = createResolutionService(ORG, createMemoryConfigStore(ORG), createAclStore());
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
  const reg = createMemoryProcessRegistry();
  const fake = fakeProcessSandbox();
  const orch = buildOrchestrator(reg, fake.sandbox);

  const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };
  const live = await fake.sandbox.startProcess!(handle, "long build");
  await reg.register({
    processId: live.processId,
    scopeId: await memoryScope(),
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
  const reg = createMemoryProcessRegistry();
  const fake = fakeProcessSandbox();
  await reg.register({
    processId: "00000000-0000-0000-0000-0000000000ff",
    scopeId: await memoryScope(),
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
  const reg = createMemoryProcessRegistry();
  const fake = fakeProcessSandbox();
  const orch = buildOrchestrator(reg, fake.sandbox);
  await orch.handleTurn(turn("!run echo hello"));
  assert.equal(fake.teardowns.length, 1);
  assert.equal(fake.teardowns[0]!.keepWarm, false);
});
