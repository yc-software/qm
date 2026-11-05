import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
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
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { interimReplyDelivery } from "../src/core/orchestrator/reply-check.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: an interim reply must not touch the sandbox");
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
  replyCheck?: OrchestratorDeps["replyCheck"],
) {
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "interim-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, config, acl),
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
    ...(replyCheck ? { replyCheck } : {}),
  });
}

async function interimTurn(request: Partial<OrchestratorInput>, threadRef: string, postFirst = false) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const deliveries = createDeliveryStore();
  const shown: boolean[] = [];
  const base = createMockAgent();
  const agent: Agent = {
    ...base,
    runTurn: async (turn) => {
      if (postFirst) await turn.tools.post?.("Here is the summary.");
      shown.push((await turn.onInterimReply?.("Core is busy. I haven't traced why.")) ?? false);
      await turn.emit({ kind: "AgentMessage", text: "Traced it." });
      return { reply: "Traced it." };
    },
  };
  const orch = buildOrchestrator(agent, sessions, deliveries);
  const result = await orch.handleTurn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [actor] } as Conversation,
    deliveryTarget: `slack:C1:${threadRef}`,
    origin: { kind: "direct" },
    text: "why is core hot?",
    runId: `run-${threadRef}`,
    ...request,
  } as OrchestratorInput);
  assert.notEqual(result.status, "error");
  const posted = (await deliveries.pending("slack")).map((d) => d.text);
  return { shown, posted };
}

test("an addressed Slack channel turn posts the prodded reply right away, then the final answer", async () => {
  const { shown, posted } = await interimTurn({ surfaceTools: true, addressed: true }, "100.1");
  assert.deepEqual(shown, [true]);
  assert.deepEqual(posted, ["Core is busy. I haven't traced why.", "Traced it."]);
});

test("an unaddressed or read-only channel turn refuses the interim reply so the prod is dropped", async () => {
  for (const [request, ref] of [
    [{ surfaceTools: true, addressed: false }, "100.2"],
    [{ surfaceTools: true, addressed: true, readOnly: true }, "100.3"],
  ] as const) {
    const { shown, posted } = await interimTurn(request, ref);
    assert.deepEqual(shown, [false]);
    assert.ok(!posted.includes("Core is busy. I haven't traced why."));
  }
});

test("a web turn shows the interim reply in its own transcript; a Slack DM gets it through the outbox", async () => {
  const web = await interimTurn(
    { surface: "web", conversation: { kind: "dm", threadRef: "web-1", audience: [actor] } as Conversation },
    "web-1",
  );
  assert.deepEqual(web.shown, [true]);
  assert.deepEqual(web.posted, []);
  const dm = await interimTurn(
    { conversation: { kind: "dm", threadRef: "D1:100.4", channelRef: "D1", audience: [actor] } as Conversation },
    "100.4",
  );
  assert.deepEqual(dm.shown, [true]);
  assert.deepEqual(dm.posted, ["Core is busy. I haven't traced why."]);
});

test("a channel turn that already posted through the surface tool refuses the interim reply", async () => {
  const { shown, posted } = await interimTurn({ surfaceTools: true, addressed: true }, "100.5", true);
  assert.deepEqual(shown, [false]);
  assert.deepEqual(posted, ["Here is the summary."]);
});

test("an interim reply has its own stable key, so a resumed attempt dedupes it and keeps the post sequence", async () => {
  const deliveries = createDeliveryStore();
  const destination = { type: "slack", target: "C1:100.6" };
  const attempt = () => {
    const postKeys = turnPostKeys("run-resume");
    const send = interimReplyDelivery({
      surfaceName: "slack",
      spineTurn: true,
      addressed: true,
      strictReadOnly: false,
      destination,
      deliveries,
      postKeys,
      provenance: () => ({}) as never,
      ackText: () => undefined,
      postedSoFar: () => 0,
    });
    return { postKeys, send };
  };
  const first = attempt();
  assert.equal(await first.send("Core is busy."), true);
  assert.equal(first.postKeys.take(), 0);
  const resumed = attempt();
  assert.equal(await resumed.send("Core is busy."), true);
  assert.deepEqual(
    (await deliveries.pending("slack")).map((d) => d.text),
    ["Core is busy."],
  );
});

test("the reply check is armed for people's turns but never for automations such as cron fires", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const deliveries = createDeliveryStore();
  const armed: string[] = [];
  const agent: Agent = { ...createMockAgent(), runTurn: async () => ({ reply: '{"ok": true}' }) };
  const orch = buildOrchestrator(agent, sessions, deliveries, async (context) => {
    armed.push(context.input);
    return undefined;
  });
  for (const [origin, text, threadRef] of [
    [{ kind: "direct" }, "from a person", "web-armed"],
    [{ kind: "automation" }, "from a cron", "web-cron"],
  ] as const)
    await orch.handleTurn({
      surface: "web",
      actor,
      conversation: { kind: "dm", threadRef, audience: [actor] } as Conversation,
      origin,
      text,
      runId: `run-${threadRef}`,
    } as OrchestratorInput);
  assert.deepEqual(armed, ["from a person"]);
});
