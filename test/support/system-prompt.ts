import type { Harness } from "../../src/harness/harness.ts";
import type { BlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";
import { type SkillBundleStore } from "../../src/skills/skill-bundle-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { createMockHarness } from "./mock-harness.ts";
import type { CronStore } from "../../src/cron/cron-store.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { ConnectorStatusCache } from "../../src/credentials/connector-status.ts";
import type { ConnectorTokenStore } from "../../src/credentials/keychain.ts";
import type { SkillStore } from "../../src/skills/skill-store.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import type { ManagedGroupDirectory } from "../../src/resolution/scope-membership.ts";
import type { IsCurrentSharedScopeMember } from "../../src/resolution/scope-membership.ts";
import { singleProcessDeps } from "./single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "./test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

export const ORG = "default-org";
export const actor: Principal = { id: "U1", type: "internal" };

export function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational !sysprompt turn must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: false,
      spec: { os: "Debian 12 (bookworm)", tools: ["git", "jq"], workdir: "/workspace", homeDir: "/root" },
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

export function readSandbox(): Sandbox {
  return {
    ...fakeSandbox(),
    provision: async () => ({ id: "read", rootDir: "/workspace" }),
    readFile: async () => null,
    teardown: async () => {},
  };
}

export const connectorStatusCache: ConnectorStatusCache = {
  get: async () => ({ principalId: actor.id, checkedAt: Date.now(), providers: { google: { connected: true } } }),
  put: async () => {},
};
export const connectorTokens = {
  listConnectorsByOwners: async () => new Map(),
  connectorAccessToken: async () => null,
  connectorTokenStatus: () => {
    throw new Error("connector tokens must not be swept when the status cache is fresh");
  },
} as unknown as ConnectorTokenStore;

export const skills = {
  visibleFor: async () => [{ skill: { manifest: { name: "deploy", description: "Deploy the app" } }, shadowed: [] }],
} as unknown as SkillStore;

export function buildOrchestrator(
  extra: {
    blobTransfer?: BlobTransferStore;
    harness?: Harness;
    memoryPolicy?: import("../../src/memory/policy.ts").MemoryPolicy;
    crons?: CronStore;
    connectorStatusCache?: ConnectorStatusCache;
    sandbox?: Sandbox;
    skills?: SkillStore;
    skillBundles?: SkillBundleStore;
    securityScreener?: SecurityScreener;
    managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members" | "version" | "withVersion" | "slackChannel">;
    isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  } = {},
) {
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "spo-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "spo-deploy"),
    auditLog,
    acl,
  });
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(testDatabaseUrl()),
    resolution: createResolutionService(config, acl),
    sessions,
    workspace,
    files,
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 1000, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory,
    deploy,
    acl,
    config,
    skills,
    connectorTokens,
    connectorStatusCache,
    resolveConnectorClient: async (provider) => {
      if (provider !== "google") throw new Error("not configured");
      return { id: "client", secret: "secret", clientRef: "test" };
    },
    signingSecret: "test-signing-secret",
    apiBaseUrl: "https://api.test",
    ...extra,
  });
  return { orchestrator, memory, config, workspace, sessions, files, auditLog, acl };
}

export const dm = (thread: string, text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  text,
  ...extra,
  origin: extra.origin ?? { kind: "direct" },
});

export const slackDm = (thread: string, text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
  ...dm(thread, text, extra),
  surface: "slack",
});
