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
import type { Harness } from "../../src/harness/harness.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import type { Outbound } from "../../src/surfaces/outbound.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { testConfigStore, testDeployBackings } from "../support/test-database.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";

const RUN_ID = "7f3c2a1e-5b4d-4c6e-8f9a-0b1c2d3e4f50";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a resumed reply must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: false,
    },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

function buildOrchestrator(
  harness: Harness,
  sessions: ReturnType<typeof createPostgresSessionStore>,
  outbound: Outbound,
) {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "rsp-")));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "rsp-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(config, acl),
    sessions,
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(databaseUrl),
    outbound,
    memoryStrategy: {},
    deploy,
    acl,
  });
}

test("a resumed turn whose dead attempt already posted does not post its closing text again", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const outbound = recordingOutbound();
  const base = createMockHarness();
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (turn) => {
        await turn.emit({ kind: "AgentMessage", text: "Done, it printed ok." });
        return { reply: "Done, it printed ok." };
      },
    },
  };
  const threadRef = "ch:C1:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", "channel:C1");
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  await sessions.appendMany(lease, [
    { kind: "UserMessage", text: "run it and tell me the output", turnId: RUN_ID },
    { kind: "ToolCall", tool: "slack", callId: "p1", turnId: RUN_ID, body: { action: "post", text: "Output: ok" } },
    {
      kind: "ToolResult",
      tool: "slack",
      callId: "p1",
      text: "[sent]",
      turnId: RUN_ID,
      body: { action: "post", ok: true },
    },
  ]);
  await sessions.releaseLease(lease);
  const orch = buildOrchestrator(harness, sessions, outbound);
  const result = await orch.handleTurn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [actor] } as Conversation,
    deliveryTarget: "slack:C1:100.1",
    origin: { kind: "direct" },
    text: "run it and tell me the output",
    surfaceTools: true,
    addressed: true,
    attempt: 2,
    runId: RUN_ID,
  } as OrchestratorInput);
  assert.notEqual(result.status, "error");
  assert.deepEqual(await outbound.pending("slack"), []);
});
