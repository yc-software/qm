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
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
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
import type { Sandbox } from "../src/sandbox/sandbox.ts";

import { createAgentTools } from "../src/harness/agent-tools.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";

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

async function scenario() {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const mailbox = createSessionMailbox(createMemoryMap<SessionMessage>());
  const featureFlags = createFeatureFlagStore(createMemoryMap());
  await featureFlags.setEnabled("persistent_subagents", "personal:U1", true, "test");
  const sessionSyscalls = createSessionSyscalls({
    sessions,
    runs,
    mailbox,
    signals: createMemoryRunSignalStore(),
    maxAttempts: 3,
  });
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
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const ref = {
          current: turn.tools,
          scopeLabel: turn.scopeLabel,
          emit: turn.emit,
          screenToolResult: turn.screenToolResult,
          pendingApprovals: [],
        };
        const tool = createAgentTools(ref).find((tool) => tool.name === "session")!;
        const execute = tool.execute as unknown as (id: string, input: unknown) => Promise<{ content: unknown[] }>;
        const result = await execute("wait-call", { action: "wait", timeoutMs: 0 });
        const reply = JSON.stringify(result.content);
        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
        return { reply, modelCalls: 1 };
      },
      async screenSecurity() {
        return { decision: "strict" as const, reason: "test quarantine" };
      },
    },
  );
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "session-mail-")));
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
    sessions,
    runs,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy: createDeployService({
      deployStore: createDeployStore(),
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
