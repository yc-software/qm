import type { NewItem } from "../src/sessions/items.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Agent } from "../src/agent/agent.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

import { createAgentTools, pauseStampAfterToolCall } from "../src/agent/agent-tools.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import {
  testAdvisoryLock,
  testConfigStore,
  testDatabaseUrl,
  testMap,
  testDeployBackings,
} from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the retry-replay tests must not provision a sandbox");
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

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:mail", audience: [actor] };

let callSeq = 0;

async function scenario() {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const mailbox = createSessionMailbox(testMap<SessionMessage>());
  const featureFlags = createFeatureFlagStore(testMap());
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const sessionSyscalls = createSessionSyscalls({
    sessions,
    runs,
    mailbox,
    signals,
    steerRun: async (run, signal) => ({ sent: await signals.send(run.id, signal) }),
    maxAttempts: 3,
    advisoryLock: testAdvisoryLock(),
  });
  const agent: Agent = {
    async runTurn(turn) {
      await turn.emit({ kind: "UserMessage", text: turn.input });
      const ref = {
        current: turn.tools,
        scopeLabel: turn.scopeLabel,
        emit: (item: NewItem) => turn.emit(item),
        screenToolResult: turn.screenToolResult,
        pendingApprovals: [],
      };
      const tool = createAgentTools(ref).find((tool) => tool.name === "subagents")!;
      const execute = tool.execute as unknown as (id: string, input: unknown) => Promise<{ content: unknown[] }>;
      const callId = `wait-call-${++callSeq}`;
      const result = await execute(callId, { action: "wait", timeoutMs: 0 });
      await pauseStampAfterToolCall(ref)({ toolCall: { id: callId }, result });
      const reply = JSON.stringify(result.content);
      await turn.emit({ kind: "AgentMessage", text: reply });
      return { reply, modelCalls: 1 };
    },
    async screenSecurity() {
      return { decision: "strict" as const, reason: "test quarantine" };
    },
  };
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const orchestrator = createOrchestrator({
    ...orchestratorTestDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, testConfigStore(ORG), acl),
    config: testConfigStore(ORG),
    sessions,
    runs,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "session-mail-deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries: createDeliveryStore(),
    featureFlags,
    sessionSyscalls,
  });
  const input: OrchestratorInput = {
    surface: "web",
    actor,
    conversation,
    origin: { kind: "human" },
    text: "Read the file",
  };
  await orchestrator.handleTurn(input);
  const parent = (await sessions.getByThread(conversation.threadRef))!;
  const sender = await sessions.getOrCreateByThread("web:U1:sender", "dm", scopeId("personal", "U1"));
  await sessions.addParticipant(sender.id, actor.id);
  await mailbox.send({
    id: "mail-one",
    senderId: sender.id,
    recipientId: parent.id,
    actor,
    audience: [actor],
    text: "QUARANTINED_FINDING",
    createdAt: Date.now(),
  });
  return { orchestrator, input, mailbox, parent };
}

for (const approved of [true, false]) {
  test(`quarantined agent message ${approved ? "approval delivers" : "denial consumes"} without another prompt`, async () => {
    const r = await scenario();
    const blocked = await r.orchestrator.handleTurn(r.input);
    const approval = blocked.pendingApprovals?.find(
      (item) => item.approvalKey === "security-screen-release:session_message_mail-one",
    );
    assert.ok(approval);
    assert.equal((await r.mailbox.pending(r.parent.id)).length, 1);
    assert.doesNotMatch(blocked.reply ?? "", /QUARANTINED_FINDING/);
    const resolved = await r.orchestrator.handleTurn({
      ...r.input,
      approval: { requestId: approval.requestId, approved },
    });
    if (approved) assert.match(resolved.reply ?? "", /QUARANTINED_FINDING/);
    else assert.equal(resolved.status, "refused");
    assert.equal((await r.mailbox.pending(r.parent.id)).length, 0);
    const next = await r.orchestrator.handleTurn(r.input);
    assert.equal(next.pendingApprovals?.length ?? 0, 0);
  });
}
