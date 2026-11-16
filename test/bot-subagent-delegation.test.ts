import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeService } from "../src/agent/runtime-control.ts";
import type { Agent, RuntimeChoice } from "../src/agent/agent.ts";
import type { RuntimeControl } from "../src/agent/runtime-types.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls, stopSessionRuns } from "../src/sessions/session-syscalls.ts";
import { liveTurnOf } from "../src/wake/route-incoming.ts";
import type { Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { McpToolService } from "../src/mcp/mcp-tool-service.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { testAdvisoryLock, testConfigStore, testDatabaseUrl, testMap } from "./support/test-database.ts";

const bot: Principal = { id: "B1", type: "internal", displayName: "Release bot" };
const alice: Principal = { id: "U1", type: "internal", displayName: "Alice" };
const active: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };

test("subagents a Slack bot's turns open and message keep the bot marker and its limits", async () => {
  const threadRef = "slack:C1:bot-subagent";
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const runtimes = new Map<string, RuntimeControl | undefined>();
  const actAsActor: Array<boolean | undefined> = [];
  const apps: string[] = [];
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
          `call-${actAsActor.length}`,
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
  const deps = orchestratorTestDeps();
  await deps.directory.replaceChannels(
    [{ channelId: "C1", name: "eng" }],
    [bot, alice].map((p) => ({ channelId: "C1", principalId: p.id })),
  );
  const orchestrator = createOrchestrator({
    ...deps,
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
    acl,
    deploy: {} as never,
    deliveries: createDeliveryStore(),
    users: { record: async () => true, markApps: async (ids: readonly string[]) => apps.push(...ids) },
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
      toolDefsFor: async (_principalId?: string, _scopeId?: string, turn?: { actAsActor?: boolean }) => {
        actAsActor.push(turn?.actAsActor);
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
    conversation: { kind: "channel", channelRef: "C1", threadRef, audience: [bot, alice] },
    origin: { kind: "human", messageTs: "1700000000.000100" },
    botActor: true,
    text: "summarize the deploy log",
  };
  await execute((await runs.enqueue({ sessionId: threadRef, request, maxAttempts: 1 })).run);
  const parent = (await sessions.getByThread(threadRef))!;
  const [child] = await sessions.childrenOf(parent.id);
  assert.ok(child, "the bot's turn opened a subagent");
  await execute((await runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!);
  const next = {
    ...request,
    origin: { kind: "human" as const, messageTs: "1700000000.000200" },
    text: "ask the helper",
  };
  await execute((await runs.enqueue({ sessionId: threadRef, request: next, maxAttempts: 1 })).run);
  const childRuns = await runs.list({ threadRef: child.threadRef });
  assert.equal(childRuns.length, 2, "the bot's second turn messaged its idle subagent");
  await execute(childRuns[0]!);
  assert.equal(childRuns[0]!.request.botActor, true);
  const fromAlice = { ...next, actor: alice, botActor: undefined, text: "and the warnings?" };
  await execute((await runs.enqueue({ sessionId: threadRef, request: fromAlice, maxAttempts: 1 })).run);
  await execute((await runs.list({ threadRef: child.threadRef, limit: 1 }))[0]!);
  const web = { ...fromAlice, surface: "web", conversation: { ...request.conversation, threadRef: child.threadRef } };
  const { run: personRun } = await runs.enqueue({ sessionId: child.threadRef, request: web, maxAttempts: 1 });
  await execute(personRun);
  await execute((await runs.get(personRun.id))!);
  const retried = (await runs.get(personRun.id))!;
  assert.deepEqual(
    [retried.request.botActor, retried.botLimited, "bot" in liveTurnOf(retried)],
    [undefined, true, false],
  );
  const stops = async (botRunsOnly: boolean) =>
    (await stopSessionRuns({ runs, signals }, child, { botRunsOnly })).some(({ id }) => id === personRun.id);
  assert.deepEqual(
    [await stops(true), await stops(false)],
    [false, true],
    "a bot's stop can't reach the person's turn",
  );
  assert.deepEqual(actAsActor, [false, false, false, false, true, false, false, false], "every turn doing bot work");
  assert.deepEqual(apps, ["B1", "B1"], "a person's turn in the bot's subagent never marks the person as an app");
  for (const ref of [threadRef, child.threadRef])
    assert.deepEqual(await runtimes.get(ref)!(active, { action: "set", model: "Astra", lifetime: "task" }), {
      ok: false,
      error: "live_actor_required",
    });
});
