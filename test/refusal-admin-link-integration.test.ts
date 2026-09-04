import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createOrchestrator } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { processRun } from "../src/runs/worker.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";
import { refusalNote } from "../src/slack/lib.ts";

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
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ral-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "ral-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory: createMemoryService(workspace),
    deploy,
    acl,
  });
}

test("a failed turn surfaces a refusal whose admin link points at the real session UUID", async () => {
  const sessions = createMemorySessionStore();
  const orchestrator = buildOrchestrator(sessions);
  const { runs } = createMemoryRunStore();
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
  assert.equal(got?.result?.adminUrl, `${ADMIN}/admin/history?session=${session!.id}`);

  const note = refusalNote(got!.result!, "channel");
  console.log("\n  Slack would post:\n  " + note + "\n");
  assert.match(note, new RegExp(`Full error: ${ADMIN}/admin/history\\?session=${session!.id}`));
  assert.doesNotMatch(note, /ch:C_UUID_FIXTURE/, "the link must not contain the threadRef");
  assert.doesNotMatch(note, /fully-internal/, "a turn failure is not a boundary refusal");
});
