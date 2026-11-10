import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Agent } from "../src/agent/agent.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { randomUUID } from "node:crypto";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a resumed reply must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "snapshot_to_workspace",
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
  agent: Agent,
  sessions: ReturnType<typeof createPostgresSessionStore>,
  deliveries: DeliveryStore,
) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "rsp-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...orchestratorTestDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
    config,
    sessions,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deliveries,
    memoryStrategy: {},
    deploy,
    acl,
  });
}

test("a resumed turn whose dead attempt already posted does not post its closing text again", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const deliveries = createDeliveryStore();
  const base = createMockAgent();
  const agent: Agent = {
    ...base,
    runTurn: async (turn) => {
      await turn.emit({ kind: "AgentMessage", text: "Done, it printed ok." });
      return { reply: "Done, it printed ok." };
    },
  };
  const threadRef = "ch:C1:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", "channel:C1");
  const runId = randomUUID();
  await sessions.appendMany({ sessionId: session.id, turnId: runId }, [
    { kind: "UserMessage", text: "run it and tell me the output" },
    { kind: "ToolCall", tool: "slack", callId: "p1", body: { action: "post", text: "Output: ok" } },
    { kind: "ToolResult", tool: "slack", callId: "p1", text: "[sent]", body: { action: "post", ok: true } },
  ]);
  const orch = buildOrchestrator(agent, sessions, deliveries);
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
    runId,
  } as OrchestratorInput);
  assert.notEqual(result.status, "error");
  assert.deepEqual(await deliveries.pending("slack"), []);
});
