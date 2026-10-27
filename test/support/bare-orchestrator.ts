import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import type { MemoryService } from "../../src/memory/memory-service.ts";
import type { MemoryStrategy } from "../../src/memory/strategy.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import type { Harness } from "../../src/harness/harness.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createMockHarness } from "./mock-harness.ts";
import { singleProcessDeps } from "./single-process.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "./test-database.ts";

export const BARE_ORG = "default-org";

/** A sandbox that fails loudly: the turns these orchestrators run must never reach a computer. */
function unreachableSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: this turn must not touch the sandbox");
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

/** A Postgres-backed orchestrator with a mock harness and no sandbox, for turns that stay conversational. */
export function buildBareOrchestrator(
  opts: { harness?: Harness; sessions?: SessionStore; memory?: MemoryService; memoryStrategy?: MemoryStrategy } = {},
) {
  const databaseUrl = testDatabaseUrl();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "bare-orchestrator-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(testConfigStore(), acl),
    sessions: opts.sessions ?? createPostgresSessionStore(databaseUrl),
    workspace: createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "bare-orchestrator-"))),
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox: unreachableSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 1000, windowMs: 60_000 }),
    harness: opts.harness ?? createMockHarness(),
    memory: opts.memory ?? createPostgresMemoryService(databaseUrl),
    ...(opts.memoryStrategy ? { memoryStrategy: opts.memoryStrategy } : {}),
    deploy,
    acl,
  });
}
