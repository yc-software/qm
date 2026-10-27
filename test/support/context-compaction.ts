import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { createRuntimeService } from "../../src/harness/runtime-control.ts";
import { createMockHarness } from "./mock-harness.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { COMPACT_HARD_FRACTION, COMPACT_SOFT_FRACTION } from "../../src/harness/context-compaction.ts";
import { countTokens } from "../../src/util/tokens.ts";
import type { Harness, HarnessCompactInput } from "../../src/harness/harness.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { contextSummary } from "../../src/sessions/session-store.ts";
import type { Item, ItemKind, NewItem } from "../../src/sessions/items.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { scopeId, type Conversation, type Principal } from "../../src/types.ts";
import { singleProcessDeps } from "./single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresErrorLog } from "../../src/admin/postgres-error-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "./test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

export const ORG = "default-org";
export const tokensOf = (...texts: string[]): number => texts.reduce((n, t) => n + countTokens(t), 0);
export const msgTexts = (n: number): string[] => Array.from({ length: n }, (_, i) => `msg ${i}`);
export const budgetBetweenSoftAndHard = (historyTokens: number): number =>
  Math.round(historyTokens / ((COMPACT_SOFT_FRACTION + COMPACT_HARD_FRACTION) / 2));
export const budgetKeepingOnlyNewest = (...newestTwoTexts: string[]): number => tokensOf(...newestTwoTexts);
export const actor: Principal = { id: "U1", type: "internal", teamIds: ["eng"] };
export const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
export const PERSONAL = scopeId("personal", "U1");

export function spyHarness(opts: { withSummarizer?: boolean } = {}) {
  const base = createMockHarness();
  const compactCalls: HarnessCompactInput[] = [];
  const harness: Harness = { ...base, models: { ...base.models } };
  if (opts.withSummarizer === false) {
    delete harness.models.compactHistory;
  } else {
    harness.models.compactHistory = async (input: HarnessCompactInput) => {
      compactCalls.push(input);
      return base.models.compactHistory!(input);
    };
  }
  return { harness, compactCalls };
}

export function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational compaction turn must not touch the sandbox");
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

export function buildOrchestrator(harness: Harness, maxContextTokens?: number, defaultTurnWallClockMs?: number) {
  const config = testConfigStore();
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const errors = createPostgresErrorLog(testDatabaseUrl());
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "cc-")));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "cc-deploy"),
    auditLog,
    acl,
  });
  const orch = createOrchestrator({
    ...singleProcessDeps(),
    config,
    identity: createIdentityService(testDatabaseUrl()),
    resolution: createResolutionService(config, acl),
    sessions,
    workspace,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    errors,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy,
    acl,
    maxContextTokens,
    defaultTurnWallClockMs,
    runtime: createRuntimeService(
      { config, baseModelDefault: "claude-sonnet-5" },
      { authorizesCapabilityScope: async () => true },
    ),
  });
  return { orch, sessions, errors, config };
}

export type Seed = Partial<Omit<NewItem, "kind">> & { kind?: ItemKind };

export async function seed(sessions: SessionStore, entries: Seed[]): Promise<string> {
  const session = await sessions.getOrCreateByThread(conv.threadRef, "dm", PERSONAL);
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease, "could not acquire lease to seed");
  for (const e of entries) {
    await sessions.append(lease!, { kind: "UserMessage", ...e } as NewItem);
  }
  await sessions.releaseLease(lease!);
  return session.id;
}

export const turn = (text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: conv,
  origin: { kind: "direct" },
  text,
});
export const spineTurn = (text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: conv,
  origin: { kind: "direct" },
  text,
  surfaceTools: true,
});

export async function summaryEntries(sessions: SessionStore, sessionId: string): Promise<Item[]> {
  return (await sessions.getItems(sessionId)).filter((e) => contextSummary(e));
}

export async function waitForSummary(sessions: SessionStore, sessionId: string, deadlineMs = 3_000): Promise<Item[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await summaryEntries(sessions, sessionId);
    if (found.length || Date.now() > deadline) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForLeaseRelease(
  sessions: SessionStore,
  sessionId: string,
  deadlineMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { lease } = await sessions.acquireLease(sessionId);
    if (lease) {
      await sessions.releaseLease(lease);
      return;
    }
    assert.ok(Date.now() < deadline, "the background pass never released the session lease");
    await new Promise((r) => setTimeout(r, 10));
  }
}
