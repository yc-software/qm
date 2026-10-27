import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createOrchestrator, type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { writableMemoryScope } from "../../src/memory/policy.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import {
  createPostgresProcessRegistry,
  isDeclaredKind,
  type ProcessRegistry,
} from "../../src/processes/process-registry.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { ProcessSessionGoneError } from "../../src/sandbox/exec-process-session.ts";
import type { Sandbox, ProcessSession, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createMockHarness } from "../support/mock-harness.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testDatabaseUrl, testConfigStore, testDeployBackings } from "../support/test-database.ts";

function backends(): Array<{ name: string; make: () => ProcessRegistry }> {
  return [{ name: "memory", make: () => createPostgresProcessRegistry(testDatabaseUrl()) }];
}

for (const b of backends()) {
  test(`[${b.name}] register stamps expiry and liveByScope returns running+unexpired`, async () => {
    const reg = b.make();
    const rec = await reg.register({
      processId: id(1),
      scopeId: "personal:U1",
      sandboxId: "sandbox-1",
      kind: "build",
      command: "aws-sso: aws sso login",
      ttlMs: 60_000,
    });
    assert.equal(rec.status, "running");
    assert.ok(rec.expiresAt > rec.startedAt);

    const live = await reg.liveByScope("personal:U1");
    assert.equal(live.length, 1);
    assert.equal(live[0]!.processId, id(1));
    assert.equal((await reg.liveByScope("personal:U2")).length, 0);
    assert.equal(await reg.hasLive("sandbox-1"), true);
    assert.equal(await reg.hasLive("sandbox-2"), false);
  });

  test(`[${b.name}] expired running sessions are not live; listExpired surfaces them WITHOUT flipping status`, async () => {
    const reg = b.make();
    await reg.register({
      processId: id(2),
      scopeId: "s",
      sandboxId: "sandbox-1",
      kind: "build",
      command: "x",
      ttlMs: -1,
    });
    assert.equal((await reg.liveByScope("s")).length, 0, "an expired session is not live");
    assert.equal(await reg.hasLive("sandbox-1"), false);

    const expired = await reg.listExpired();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.processId, id(2));
    assert.equal((await reg.get(id(2)))!.status, "running", "marking dead happens only after a confirmed kill");

    await reg.markStatus(id(2), "reaped");
    assert.equal((await reg.get(id(2)))!.status, "reaped");
    assert.equal((await reg.listExpired()).length, 0);
  });

  test(`[${b.name}] markStatus and delete`, async () => {
    const reg = b.make();
    await reg.register({
      processId: id(3),
      scopeId: "s",
      sandboxId: "sandbox-1",
      kind: "build",
      command: "make",
      ttlMs: 60_000,
    });
    await reg.markStatus(id(3), "exited");
    assert.equal((await reg.liveByScope("s")).length, 0);
    assert.equal((await reg.get(id(3)))!.status, "exited");
    await reg.delete(id(3));
    assert.equal(await reg.get(id(3)), null);
  });

  test(`[${b.name}] only declared kinds may be registered`, async () => {
    const reg = b.make();
    await assert.rejects(
      reg.register({
        processId: id(4),
        scopeId: "s",
        sandboxId: "sandbox-1",
        kind: "shell" as never,
        command: "sh",
        ttlMs: 1000,
      }),
      /not declared/,
    );
  });
}

test("isDeclaredKind gates which kinds may outlive a turn", () => {
  assert.equal(isDeclaredKind("build"), true);
  assert.equal(isDeclaredKind("auth"), false);
  assert.equal(isDeclaredKind("dev-server"), true);
  assert.equal(isDeclaredKind("browser-login"), false);
  assert.equal(isDeclaredKind("browser-agent"), false);
  assert.equal(isDeclaredKind("background"), true);
  assert.equal(isDeclaredKind("shell"), false);
});

for (const b of backends()) {
  test(`[${b.name}] a background kind registers and stamps expiresAt=now+ttlMs`, async () => {
    const reg = b.make();
    const before = Date.now();
    const rec = await reg.register({
      processId: id(7),
      scopeId: "personal:U1",
      sandboxId: "sandbox-1",
      kind: "background",
      command: "bg: npm test",
      ttlMs: 1_800_000,
    });
    assert.equal(rec.status, "running");
    assert.equal(rec.kind, "background");
    assert.ok(rec.expiresAt >= before + 1_800_000);
    assert.ok(rec.expiresAt <= Date.now() + 1_800_000);
    assert.equal((await reg.liveByScope("personal:U1")).length, 1);
  });
}

const PG_URL = process.env.TEST_DATABASE_URL;
test("[postgres] honors the registry contract (durable across a restart)", { skip: !PG_URL }, async () => {
  const reg = createPostgresProcessRegistry(PG_URL!);
  const scope = `pg-test-${Date.now()}`;
  try {
    const rec = await reg.register({
      processId: id(1),
      scopeId: scope,
      sandboxId: "sandbox-1",
      kind: "dev-server",
      command: "npm run dev",
      purpose: "Preview app server",
      ttlMs: 60_000,
    });
    assert.equal(rec.status, "running");
    assert.ok(rec.expiresAt > rec.startedAt);

    const reg2 = createPostgresProcessRegistry(PG_URL!);
    const live = await reg2.liveByScope(scope);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.processId, id(1));
    assert.equal(typeof live[0]!.expiresAt, "number");
    assert.equal(live[0]!.purpose, "Preview app server");

    await reg2.register({
      processId: id(2),
      scopeId: scope,
      sandboxId: "sandbox-1",
      kind: "build",
      command: "y",
      ttlMs: -1,
    });
    assert.equal(
      (await reg2.listExpired()).some((r) => r.processId === id(2)),
      true,
    );
    await reg2.delete(id(1));
    await reg2.delete(id(2));
    reg2.close?.();
  } finally {
    reg.close?.();
  }
});

for (const [name, make] of [
  ["memory", () => createPostgresProcessRegistry(testDatabaseUrl())],
  ...(PG_URL ? [["postgres", () => createPostgresProcessRegistry(PG_URL)] as const] : []),
] as const) {
  test(`[${name}] background credential files survive a new registry until settled`, async () => {
    const reg = make();
    const credentialFiles = {
      plan: { directory: "/tmp/qm-credentials.abc", credentials: [{ paths: [".aws/config"], roots: [] }] },
      sources: [{ credentialId: "c1", ownerId: "U1", service: "aws", fingerprint: "f1" }],
    };
    const processId = id(Date.now() % 1_000_000);
    try {
      await reg.register({
        processId,
        scopeId: "personal:U1",
        sandboxId: "sandbox-1",
        kind: "background",
        command: "x",
        ttlMs: 60_000,
        credentialFiles,
      });
      const reopened = name === "postgres" ? make() : reg;
      assert.deepEqual(await reopened.credentialFiles(processId), credentialFiles);
      assert.equal((await reopened.get(processId))?.credentialsPending, true);
      await reopened.setCredentialFiles(processId, null);
      assert.equal(await reg.credentialFiles(processId), null);
      assert.equal((await reg.get(processId))?.credentialsPending, undefined);
      if (reopened !== reg) reopened.close?.();
    } finally {
      await reg.delete(processId);
      reg.close?.();
    }
  });
}

function id(n: number): string {
  const s = n.toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${s}`;
}

test("registry preserves purpose without replacing the command and accepts legacy rows", async () => {
  const registry = createPostgresProcessRegistry(testDatabaseUrl());
  for (const purpose of [undefined, "Preview app server"]) {
    const row = await registry.register({
      processId: purpose ?? "legacy",
      scopeId: "personal:U1",
      sandboxId: "sandbox-1",
      kind: "background",
      command: "bg: node server.js",
      ttlMs: 60_000,
      ...(purpose ? { purpose } : {}),
    });
    assert.equal((await registry.get(row.processId))?.purpose, purpose);
    assert.equal((await registry.get(row.processId))?.command, "bg: node server.js");
  }
});

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
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
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
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(config, acl),
    sessions: createPostgresSessionStore(databaseUrl),
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 100, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory: createPostgresMemoryService(databaseUrl),
    deploy,
    acl,
    processes,
  });
}

async function memoryScope(): Promise<string> {
  const resolution = createResolutionService(
    testConfigStore(),
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
