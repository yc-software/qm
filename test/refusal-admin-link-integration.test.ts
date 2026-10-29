import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createOrchestrator } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { processRun } from "../src/runs/worker.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { refusalNote } from "../src/slack/lib.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const ORG = "default-org";
const ADMIN = "https://portal.example.com";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a failed turn must not touch the sandbox");
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

function buildOrchestrator(sessions: SessionStore) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ral-")));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "ral-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 1000, windowMs: 60_000 }),
    agent: createMockAgent(),
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy,
    acl,
  });
}

test("a failed turn surfaces a refusal whose admin link points at the real session UUID", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const orchestrator = buildOrchestrator(sessions);
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const leaseTtlMs = 60_000;

  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const request = {
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef, audience: [actor] } as Conversation,
    origin: { kind: "direct" as const },
    text: "!boom",
  };
  const { run } = await runs.enqueue({ sessionId: threadRef, request, maxAttempts: 1 });

  const claimed = await runs.claimById(run.id, "w1", leaseTtlMs);
  assert.ok(claimed, "claimed for processing");
  await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs }, claimed!), /boom/);

  const stored = await runs.get(run.id);
  assert.equal(stored?.result?.status, "failed");
  assert.equal(stored?.result?.sessionId, threadRef, "raw stored result holds the threadRef");

  const session = await sessions.getByThread(threadRef);
  assert.ok(session, "session row exists for the threadRef");

  const app = createApp({ sessions, runs, publicWebUrl: ADMIN } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session!.id, "getRun resolved threadRef → real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(got?.result?.adminUrl, `${ADMIN}/admin/history/s/${session!.id}`);

  const note = refusalNote(got!.result!, "channel");
  console.log("\n  Slack would post:\n  " + note + "\n");
  assert.equal(note.split("Full error: ")[1], `${ADMIN}/admin/history/s/${session!.id} Try again, or DM me.`);
  assert.doesNotMatch(note, /ch:C_UUID_FIXTURE/, "the link must not contain the threadRef");
  assert.doesNotMatch(note, /fully-internal/, "a turn failure is not a boundary refusal");
});
