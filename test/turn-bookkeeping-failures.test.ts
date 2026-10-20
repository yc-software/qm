import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { defineHarness } from "../src/harness/harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { HarnessTurnResult } from "../src/harness/harness.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { isOverheard } from "../src/sessions/items.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = {
  kind: "channel",
  threadRef: "ch:C1:bookkeeping",
  channelRef: "C1",
  audience: [actor],
};
scopeId("channel", "C1");

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the bookkeeping tests must not provision a sandbox");
  };
  return {
    profile: { backend: "fake", writablePersistence: "snapshot_to_workspace", processSessions: false },
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

function buildScenario(turnResult?: Partial<HarnessTurnResult>) {
  const harness = defineHarness(
    {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(),
    },
    {
      async runTurn(turn) {
        await turn.emit({ kind: "UserMessage", text: turn.input });
        await turn.emit({ kind: "AgentMessage", text: "done" });
        return { reply: "done", modelCalls: 1, ...turnResult };
      },
      async screenSecurity() {
        return { decision: "auto" as const };
      },
    },
  );
  const sessions = createMemorySessionStore();
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "bookkeeping-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "bookkeeping-deploy"),
    auditLog,
    acl,
  });
  const deliveries = createDeliveryStore();
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy,
    acl,
    deliveries,
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "slack",
    actor,
    conversation,
    origin: { kind: "direct" },
    text,
    ...extra,
  });
  return { orchestrator, sessions, deliveries, input };
}

test("a cancel-stopped turn still persists and surfaces its pending approvals", async () => {
  const { orchestrator, input } = buildScenario({
    reply: "",
    stopped: true,
    pendingApprovals: [{ command: "rm -rf /srv/data", reason: "destructive command" }],
  });
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.handleTurn(input("wipe the data dir", { cancel: controller.signal }));
  assert.equal(result.status, "pending_approval", "the approval is surfaced, not orphaned by the cancel");
  assert.equal(result.pendingApprovals?.length, 1);
  assert.equal(result.pendingApprovals?.[0]?.command, "rm -rf /srv/data");
});

test("an overheard import failure aborts the batch instead of skipping one message", async () => {
  const { orchestrator, sessions, input } = buildScenario();
  await orchestrator.handleTurn(input("prime"));
  const appendMany = sessions.appendMany.bind(sessions);
  sessions.appendMany = async (lease, entries) => {
    if (
      entries.some(
        (entry) => entry.kind === "UserMessage" && entry.body?.overheard === true && entry.externalId === "200.2",
      )
    )
      throw new Error("append refused");
    return appendMany(lease, entries);
  };
  const request = input("what did I miss?", {
    overheard: [
      { role: "user", name: "Ann", text: "first overheard", ts: "100.1" },
      { role: "user", name: "Bob", text: "second overheard", ts: "200.2" },
      { role: "user", name: "Cee", text: "third overheard", ts: "300.3" },
    ],
  });
  const result = await orchestrator.handleTurn(request);
  assert.equal(result.status, "ok");
  const session = (await sessions.getByThread(conversation.threadRef))!;
  const overheardTexts = (await sessions.getItems(session.id)).filter(isOverheard).map((e) => e.text);
  assert.deepEqual(overheardTexts, [], "the atomic batch leaves no partial history on failure");
  sessions.appendMany = appendMany;
  await orchestrator.handleTurn(request);
  await orchestrator.handleTurn(request);
  const recovered = (await sessions.getItems(session.id)).filter(isOverheard).map((e) => e.text);
  assert.deepEqual(
    recovered,
    ["first overheard", "second overheard", "third overheard"],
    "retry imports the whole batch once, in order",
  );
});
