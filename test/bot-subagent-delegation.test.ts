import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeService } from "../src/agent/runtime-control.ts";
import type { Agent, RuntimeChoice } from "../src/agent/agent.ts";
import type { RuntimeControl } from "../src/agent/runtime-types.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { McpToolService } from "../src/mcp/mcp-tool-service.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import {
  testAdvisoryLock,
  testConfigStore,
  testDatabaseUrl,
  testDeployBackings,
  testMap,
} from "./support/test-database.ts";

const bot: Principal = { id: "B1", type: "internal", displayName: "Release bot" };
const scope = scopeId("personal", bot.id);
const active: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };

async function botTurnOpensSubagent(threadRef: string, followUp?: string) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const featureFlags = createFeatureFlagStore(testMap());
  await featureFlags.setEnabled("responsive_spine", scope, true, "test");
  const runtimes = new Map<string, RuntimeControl | undefined>();
  const actAsActor: Array<boolean | undefined> = [];
  const agent: Agent = {
    async runTurn(turn) {
      runtimes.set(turn.session.threadRef, turn.runtimeControl);
      if (!turn.session.parentSessionId) {
        const ref = {
          current: turn.tools,
          scopeLabel: turn.scopeLabel,
          emit: turn.emit,
          screenToolResult: turn.screenToolResult,
          pendingApprovals: [],
        };
        const open = createAgentTools(ref, {
          readOnly: turn.readOnly,
          sessionTools: Boolean(turn.tools.sessionSyscalls),
          surfaceTools: turn.surfaceTools,
          delegateWork: turn.delegateWork,
          surfaceName: turn.surfaceName,
        }).find((t) => t.name === "subagents")!.execute as unknown as (id: string, input: unknown) => Promise<unknown>;
        const [child] = await sessions.childrenOf(turn.session.id);
        await open(
          `call-${runtimes.size}`,
          child
            ? { action: "send_message", target: child.id, text: "how many errors were in the log?" }
            : { action: "open", task: "summarize the deploy log" },
        );
      }
      return { reply: "done", modelCalls: 1 };
    },
  };
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const config = testConfigStore("org");
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    config,
    runtime: createRuntimeService(
      { config, baseModelDefault: "claude-opus-5" },
      { authorizesCapabilityScope: async () => true },
    ),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService("org", config, acl),
    sessions,
    runs,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: { profile: { backend: "fake", writablePersistence: "snapshot_to_workspace" } } as Sandbox,
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "bot-subagent-delegation-deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries: createDeliveryStore(),
    featureFlags,
    sessionSyscalls: createSessionSyscalls({
      advisoryLock: testAdvisoryLock(),
      sessions,
      runs,
      mailbox: createSessionMailbox(testMap<SessionMessage>()),
      signals,
      steerRun: async (run, signal) => ({ sent: await signals.send(run.id, signal) }),
      maxAttempts: 1,
    }),
    mcp: {
      toolDefsFor: async (_principalId?: string, _scopeId?: string, actAs?: boolean) => {
        actAsActor.push(actAs);
        return [];
      },
    } as unknown as McpToolService,
  });
  const execute = async (run: Run) => {
    const result = await orchestrator.handleTurn({ ...run.request, runId: run.id });
    assert.equal(result.status, "ok", result.reply);
  };
  const request: OrchestratorInput = {
    surface: "slack",
    actor: bot,
    conversation: { kind: "dm", threadRef, audience: [bot] },
    origin: { kind: "human", messageTs: "1700000000.000100" },
    botActor: true,
    text: "summarize the deploy log",
  };
  await execute((await runs.enqueue({ sessionId: threadRef, request, maxAttempts: 1 })).run);
  const parent = (await sessions.getByThread(threadRef))!;
  const [child] = await sessions.childrenOf(parent.id);
  assert.ok(child, "the bot's turn opened a subagent");
  await execute((await runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!);
  if (followUp) {
    const next = { ...request, origin: { kind: "human" as const, messageTs: "1700000000.000200" }, text: followUp };
    await execute((await runs.enqueue({ sessionId: threadRef, request: next, maxAttempts: 1 })).run);
  }
  const childRun = (await runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!;
  if (followUp) await execute(childRun);
  return {
    childRequest: childRun.request,
    childRuns: (await runs.list({ threadRef: child.threadRef })).length,
    parentRuntime: runtimes.get(threadRef)!,
    childRuntime: runtimes.get(child.threadRef)!,
    actAsActor,
  };
}

test("a subagent opened by a Slack bot's turn is still refused live-person runtime changes", async () => {
  const w = await botTurnOpensSubagent("slack:dm:bot-runtime");
  const set = { action: "set", model: "Astra", lifetime: "task" } as const;
  assert.deepEqual(await w.parentRuntime(active, set), { ok: false, error: "live_actor_required" });
  assert.deepEqual(await w.childRuntime(active, set), { ok: false, error: "live_actor_required" });
});

test("a subagent opened by a Slack bot's turn keeps the bot marker and never acts as its actor", async () => {
  const w = await botTurnOpensSubagent("slack:dm:bot-marker");
  assert.deepEqual(w.actAsActor, [false, false], "parent then child actAsActor passed to MCP");
  assert.equal(w.childRequest.botActor, true);
});

test("a message a Slack bot's turn sends to its subagent keeps the bot marker", async () => {
  const w = await botTurnOpensSubagent("slack:dm:bot-message", "ask the helper how many errors it found");
  assert.equal(w.childRuns, 2, "the bot's second turn messaged its idle subagent");
  assert.equal(w.childRequest.botActor, true);
  assert.deepEqual(w.actAsActor, [false, false, false, false], "every turn the bot started or messaged");
  assert.deepEqual(await w.childRuntime(active, { action: "set", model: "Astra", lifetime: "task" }), {
    ok: false,
    error: "live_actor_required",
  });
});
