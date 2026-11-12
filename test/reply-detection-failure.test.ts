import { test } from "node:test";
import { testTenant } from "./support/test-tenant.ts";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Agent } from "../src/agent/agent.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const actor: Principal = { id: "U1", type: "internal" };

function orchestratorFor(agent: Agent) {
  const config = testConfigStore("default-org");
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const errors = createPostgresErrorLog(testDatabaseUrl());
  const orch = createOrchestrator({
    ...orchestratorTestDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService("default-org", config, acl),
    config,
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: {
      profile: { backend: "fake", writablePersistence: "snapshot_to_workspace", processSessions: false },
    } as Sandbox,
    auditLog,
    errors,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "rdf-deploy"),
      auditLog,
      acl,
    }),
    acl,
  });

  return { orch, auditLog, errors };
}

test("an ambient message whose reply detection fails stays silent and leaves the failure in the error and audit logs", async () => {
  const base = createMockAgent();
  let ran = false;
  const agent: Agent = {
    ...base,
    runTurn: async () => {
      ran = true;
      return { reply: "spurious" };
    },
    shouldRespond: async () => {
      throw new Error("401 invalid x-api-key");
    },
  };
  const { orch, auditLog, errors } = orchestratorFor(agent);

  const result = await orch.handleTurn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C1:200.1", channelRef: "C1", audience: [actor] } as Conversation,
    origin: { kind: "ambient" },
    text: "anyone know why the deploy is stuck?",
  });

  assert.equal(result.status, "silent");
  assert.equal(ran, false);
  const [failure] = await errors.list(testTenant, { sessionId: result.sessionId! });
  assert.deepEqual(
    { category: failure?.category, code: failure?.code, message: failure?.message },
    { category: "turn", code: "detection_failed", message: "401 invalid x-api-key" },
  );
  const silent = (await auditLog.events(testTenant)).find((e) => e.action === "turn.silent");
  assert.equal(silent?.detail, "detection failed: 401 invalid x-api-key");
});

test("ambient reply detection runs on the model the session is using", async () => {
  const base = createMockAgent();
  let detectModel: string | undefined;
  const agent: Agent = {
    ...base,
    shouldRespond: async (detect) => {
      detectModel = detect.runtime?.modelId;
      return { respond: false };
    },
  };
  const { orch } = orchestratorFor(agent);

  const result = await orch.handleTurn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C1:300.1", channelRef: "C1", audience: [actor] } as Conversation,
    origin: { kind: "ambient" },
    model: "claude-sonnet-5",
    text: "how's it going?",
  });

  assert.equal(result.status, "silent");
  assert.equal(detectModel, "claude-sonnet-5");
});
