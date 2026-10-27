import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../../src/core/orchestrator.ts";
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
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresErrorLog } from "../../src/admin/postgres-error-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

const actor: Principal = { id: "U1", type: "internal" };

test("an ambient message whose reply detection fails stays silent and leaves the failure in the error and audit logs", async () => {
  const databaseUrl = testDatabaseUrl();
  const base = createMockHarness();
  let ran = false;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async () => {
        ran = true;
        return { reply: "spurious" };
      },
    },
    models: {
      ...base.models,
      shouldRespond: async () => {
        throw new Error("401 invalid x-api-key");
      },
    },
  };
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const errors = createPostgresErrorLog(databaseUrl);
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "rdf-")));
  const orch = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(config, acl),
    sessions: createPostgresSessionStore(databaseUrl),
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox: {
      profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: false },
    } as Sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    errors,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(databaseUrl),
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

  const result = await orch.handleTurn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C1:200.1", channelRef: "C1", audience: [actor] } as Conversation,
    origin: { kind: "ambient" },
    text: "anyone know why the deploy is stuck?",
  });

  assert.equal(result.status, "silent");
  assert.equal(ran, false);
  const [failure] = await errors.list({ sessionId: result.sessionId! });
  assert.deepEqual(
    { category: failure?.category, code: failure?.code, message: failure?.message },
    { category: "turn", code: "detection_failed", message: "401 invalid x-api-key" },
  );
  const silent = (await auditLog.events()).find((e) => e.action === "turn.silent");
  assert.equal(silent?.detail, "detection failed: 401 invalid x-api-key");
});
