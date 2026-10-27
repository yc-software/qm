import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeService } from "../../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../../src/harness/runtime-recovery.ts";
import type { CapabilityClaims } from "../../src/auth/capability-token.ts";
import { type RuntimeChoice, defineHarness } from "../../src/harness/harness.ts";
import { storedItem } from "../../src/sessions/items.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testAdvisoryLock } from "../support/test-database.ts";
import type { RuntimeControl } from "../../src/harness/runtime-types.ts";
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
import { createAgentTools, type AgentToolsOptions } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createFeatureFlagStore, type FeatureName } from "../../src/feature-flags.ts";
import { createSessionMailbox } from "../../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { createMemoryRunSignalStore } from "../../src/runs/run-signal-store.ts";
import { scopeId, type Principal, type Session } from "../../src/types.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { Run } from "../../src/runs/run-store.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import type { McpToolService } from "../../src/mcp/mcp-tool-service.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { testRunStore } from "../support/turns.ts";

const active: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };
const claims: CapabilityClaims = {
  actorId: "alice",
  scopeId: "personal:alice",
  liveActor: true,
  exp: Date.now() + 60000,
};
async function setup(allowed = true) {
  const config = testConfigStore();
  await config.setRuntimeSelection("org:default-org", active);
  const service = createRuntimeService(
    { config, baseModelDefault: active.modelId },
    {
      authorizesCapabilityScope: async () => allowed,
    },
  );
  return { config, service };
}

test("runtime exposes actual dispatch separately from saved defaults and resolves Astra without losing settings", async () => {
  const { config, service } = await setup();
  const running = { ...active, modelId: "claude-sonnet-5" };
  const state = await service(claims, running, { action: "get" });
  assert.equal(state.ok, true);
  assert.deepEqual(state.active, running);
  assert.equal((state.effective as RuntimeChoice).modelId, active.modelId);
  const result = await service(claims, running, { action: "set", model: "Astra" });
  assert.deepEqual(result, { ok: true, handoff: { lifetime: "task", choice: { ...running, modelId: "gpt-6-astra" } } });
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("scope defaults persist and inherit clears them", async () => {
  const { config, service } = await setup();
  const result = await service(claims, active, { action: "set", model: "Astra", lifetime: "scope" });
  assert.equal(result.ok, true);
  assert.equal((await config.getRuntimeSelectionDurable(claims.scopeId))?.modelId, "gpt-6-astra");
  const inherited = await service(claims, active, { action: "inherit", lifetime: "scope" });
  assert.equal(inherited.ok, true);
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("runtime changes reject revoked access, bots, triggers and foreign personal scopes", async () => {
  const denied = await setup(false);
  assert.deepEqual(await denied.service(claims, active, { action: "get" }), { ok: false, error: "forbidden" });
  const { service } = await setup();
  for (const extra of [{ botActor: true }, { triggered: true }, { liveActor: false }]) {
    assert.deepEqual(await service({ ...claims, ...extra }, active, { action: "set", model: "Astra" }), {
      ok: false,
      error: "live_actor_required",
    });
  }
  assert.deepEqual(await service({ ...claims, scopeId: "personal:bob" }, active, { action: "set", model: "Astra" }), {
    ok: false,
    error: "forbidden",
  });
});

test("runtime rejects unsupported effort and fast mode instead of silently dropping them", async () => {
  const { service } = await setup();
  assert.deepEqual(await service(claims, active, { action: "set", effort: "extreme" }), {
    ok: false,
    error: "effort_not_supported",
  });
  assert.deepEqual(await service(claims, active, { action: "set", model: "claude-sonnet-5", fastMode: true }), {
    ok: false,
    error: "fast_mode_not_supported",
  });
});

test("account preflight failure cannot change a scope default", async () => {
  const { service, config } = await setup();
  const result = await service(
    claims,
    active,
    { action: "set", model: "Astra", lifetime: "scope" },
    async () => "account does not support this runtime",
  );
  assert.equal(result.ok, false);
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("runtime recovery uses only durable decisions belonging to the same run and actor", () => {
  const run = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const entry = (turnId: string, actorId: string, modelId: string) =>
    storedItem(
      {
        kind: "ToolResult",
        tool: "runtime",
        callId: "c1",
        turnId,
        body: { actorId, runtimeHandoff: { choice: { ...active, modelId }, lifetime: "task" } },
      },
      { sessionId: "s", seq: 1, createdAt: 1 },
    );
  const entries = [
    entry(run, "alice", "gpt-6-astra"),
    entry(other, "alice", "claude-sonnet-5"),
    entry(run, "bob", "claude-opus-5"),
  ];
  assert.equal(recoveredRuntime(entries, run, "alice")?.choice.modelId, "gpt-6-astra");
  assert.equal(recoveredRuntime(entries, "00000000-0000-4000-8000-000000000003", "alice"), undefined);
});

test("individual-account availability does not depend on organization provider keys", async () => {
  const { config } = await setup();
  const service = createRuntimeService(
    { config, providerKeys: { anthropic: false, openai: false, openrouter: false } },
    { authorizesCapabilityScope: async () => true },
  );
  const ownRuntime = { ...active, modelId: "gpt-6-astra" };
  const result = await service(
    claims,
    ownRuntime,
    { action: "set", effort: "xhigh" },
    async (choice) => (choice.modelId === "gpt-6-astra" ? null : "no account"),
    true,
  );
  assert.deepEqual(result, {
    ok: true,
    handoff: { lifetime: "task", choice: { ...ownRuntime, effortLevel: "xhigh" } },
  });
});

test("a saved override removed from the model picker cannot be newly selected", async () => {
  const { config, service } = await setup();
  await config.setRuntimeSelection(claims.scopeId, { ...active, modelId: "gpt-6-astra" });
  await config.setSetting("webuiModels", ["claude-sonnet-5"], "org:default-org");
  assert.deepEqual(await service(claims, active, { action: "set", model: "Astra" }), {
    ok: false,
    error: "model_not_enabled",
  });
});

test("cancellation during validation prevents a scope write", async () => {
  const { config, service } = await setup();
  const controller = new AbortController();
  const result = await service(
    claims,
    active,
    { action: "set", model: "Astra", lifetime: "scope" },
    async () => {
      controller.abort();
      return null;
    },
    false,
    controller.signal,
  );
  assert.deepEqual(result, { ok: false, error: "cancelled" });
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("cron fires may change their task runtime without changing saved defaults", async () => {
  const { service, config } = await setup();
  const cronClaims = { ...claims, liveActor: false, triggered: true };
  const result = await service(
    cronClaims,
    active,
    { action: "set", model: "Astra" },
    undefined,
    false,
    undefined,
    true,
  );
  assert.deepEqual(result, { ok: true, handoff: { lifetime: "task", choice: { ...active, modelId: "gpt-6-astra" } } });
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
  for (const action of ["set", "inherit"] as const) {
    assert.deepEqual(
      await service(
        cronClaims,
        active,
        { action, model: "Astra", lifetime: "scope" },
        undefined,
        false,
        undefined,
        true,
      ),
      { ok: false, error: "live_actor_required" },
    );
  }
  assert.equal(await config.getRuntimeSelectionDurable(claims.scopeId), null);
});

test("cron task handoffs still enforce actor, access, model and account policy", async () => {
  const { service, config } = await setup();
  const cronClaims = { ...claims, liveActor: false, triggered: true };
  assert.deepEqual(
    await service(
      { ...cronClaims, botActor: true },
      active,
      { action: "set", model: "Astra" },
      undefined,
      false,
      undefined,
      true,
    ),
    { ok: false, error: "live_actor_required" },
  );
  assert.deepEqual(
    await service(
      { ...cronClaims, scopeId: "personal:bob" },
      active,
      { action: "set", model: "Astra" },
      undefined,
      false,
      undefined,
      true,
    ),
    { ok: false, error: "forbidden" },
  );
  const denied = await setup(false);
  assert.deepEqual(
    await denied.service(cronClaims, active, { action: "set", model: "Astra" }, undefined, false, undefined, true),
    { ok: false, error: "forbidden" },
  );
  const result = await service(
    cronClaims,
    active,
    { action: "set", model: "Astra" },
    async () => "unavailable account",
    true,
    undefined,
    true,
  );
  assert.equal(result.ok, false);
  await config.setRuntimeSelection(claims.scopeId, { ...active, modelId: "gpt-6-astra" });
  await config.setSetting("webuiModels", ["claude-sonnet-5"], "org:default-org");
  assert.deepEqual(
    await service(cronClaims, active, { action: "set", model: "Astra" }, undefined, false, undefined, true),
    { ok: false, error: "model_not_enabled" },
  );
});

test("cron inherit cannot select a saved model removed from policy", async () => {
  const { service, config } = await setup();
  await config.setRuntimeSelection(claims.scopeId, { ...active, modelId: "gpt-6-astra" });
  await config.setSetting("webuiModels", ["claude-sonnet-5"], "org:default-org");
  assert.deepEqual(
    await service(
      { ...claims, liveActor: false, triggered: true },
      active,
      { action: "inherit" },
      undefined,
      false,
      undefined,
      true,
    ),
    { ok: false, error: "model_not_enabled" },
  );
});

type Call = { tool: string; args: Record<string, unknown> };
type Turn = {
  ref: TurnToolStateInit;
  runtime?: RuntimeControl;
  requestedRuntime?: Partial<RuntimeChoice>;
  options: AgentToolsOptions;
  tools: string[];
  results: Array<{ isError?: unknown }>;
  started: Session[];
};

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");
const SUBAGENT_EXCEPTIONS = {
  surfaceTools: "a subagent's result returns to its parent, which owns posting to the conversation",
  delegateWork: "a subagent is the delegate, so it does the work instead of delegating again",
} satisfies Partial<Record<keyof AgentToolsOptions, string>>;
const exceptions = Object.keys(SUBAGENT_EXCEPTIONS) as (keyof AgentToolsOptions)[];

async function world(flags: FeatureName[], next: (turn: Turn, subagent: boolean) => Call | undefined) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = testRunStore();
  const featureFlags = createFeatureFlagStore(testDatabaseUrl());
  for (const flag of flags) await featureFlags.setEnabled(flag, scope, true, "test");
  const sidebar: Session[] = [];
  const sessionSyscalls = createSessionSyscalls({
    advisoryLock: testAdvisoryLock(),
    sessions,
    runs,
    mailbox: createSessionMailbox(testDatabaseUrl()),
    signals: createMemoryRunSignalStore(),
    maxAttempts: 1,
    conversations: {
      list: async () => sidebar,
      start: async (_actorId, input) => {
        const session = await sessions.getOrCreateByThread(`web:U1:started-${sidebar.length}`, "dm", input.scopeId);
        await sessions.addParticipant(session.id, actor.id);
        await sessions.setSpawnMeta(session.id, {
          surface: "web",
          actor,
          conversation: { kind: "dm", threadRef: session.threadRef, audience: [actor] },
        });
        sidebar.push(session);
        return { session };
      },
    },
  });
  const turns = new Map<string, Turn>();
  const harness = defineHarness({
    async runTurn(turn) {
      const results: Turn["results"] = [];
      const ref = {
        current: turn.tools,
        scopeLabel: turn.scopeLabel,
        emit: async (entry: Parameters<typeof turn.emit>[0]) => {
          if (entry.kind === "ToolResult") results.push({ isError: entry.isError ?? undefined });
          return turn.emit(entry);
        },
        observeToolResult: turn.observeToolResult,
      };
      const options: AgentToolsOptions = {
        ...(turn.mcpTools?.length ? { mcpTools: turn.mcpTools } : {}),
        readOnly: turn.readOnly,
        sessionTools: Boolean(turn.tools.sessionSyscalls),
        surfaceTools: turn.surfaceTools,
        delegateWork: turn.delegateWork,
        surfaceName: turn.surfaceName,
        ...(turn.clientTools?.length ? { clientTools: turn.clientTools } : {}),
      };
      const tools = createAgentTools(createTurnToolState(ref), options);
      const record: Turn = {
        ref,
        runtime: turn.runtimeControl,
        requestedRuntime: turn.runtime,
        options,
        tools: tools.map((t) => t.name).sort(),
        results,
        started: sidebar,
      };
      turns.set(turn.session.threadRef, record);
      for (
        let call = next(record, !!turn.session.parentSessionId);
        call;
        call = next(record, !!turn.session.parentSessionId)
      ) {
        const execute = tools.find((t) => t.name === call.tool)!.execute as unknown as (
          id: string,
          input: unknown,
        ) => Promise<unknown>;
        await execute(`call-${results.length}`, call.args);
      }
      return { reply: "done", modelCalls: 1 };
    },
  });
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "subagent-parity-")));
  const config = testConfigStore();
  await config.setSetting("interactiveFastMode", true);
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    config,
    runtime: createRuntimeService(
      { config, baseModelDefault: "claude-opus-5" },
      { authorizesCapabilityScope: async () => true },
    ),
    identity: createIdentityService(testDatabaseUrl()),
    resolution: createResolutionService(config, acl),
    sessions,
    runs,
    workspace,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox: { profile: { backend: "fake", writablePersistence: "resident_disk" } } as Sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(testDatabaseUrl(), { maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "subagent-parity-deploy"),
      auditLog,
      acl,
    }),
    acl,
    outbound: recordingOutbound(),
    featureFlags,
    sessionSyscalls,
    mcp: {
      toolDefsFor: async (principalId?: string) =>
        principalId === actor.id
          ? [
              {
                name: "orders_search",
                serverId: "orders",
                remoteName: "search",
                description: "Search orders",
                inputSchema: { type: "object", properties: {} },
                readOnly: true,
              },
            ]
          : [],
    } as unknown as McpToolService,
  });
  const execute = async (run: Run) => {
    const result = await orchestrator.handleTurn({ ...run.request, runId: run.id });
    assert.equal(result.status, "ok", result.reply);
  };
  const parentTurn = async (surface: string, threadRef: string) => {
    const conversation = { kind: "dm" as const, threadRef, audience: [actor] };
    const request: OrchestratorInput = { surface, actor, conversation, origin: { kind: "human" }, text: "go" };
    await execute((await runs.enqueue({ sessionId: threadRef, request, maxAttempts: 1 })).run);
    const parent = (await sessions.getByThread(threadRef))!;
    const [child] = await sessions.childrenOf(parent.id);
    assert.ok(child, "the parent opened a subagent");
    await execute((await runs.latestForThread(child.threadRef))!);
    return { parent: turns.get(threadRef)!, child: turns.get(child.threadRef)! };
  };
  return { parentTurn };
}

const failed = (result: Turn["results"][number]) => result.isError === true;

function script(turn: Turn, subagent: boolean): Call | undefined {
  const calls: Call[] = [
    ...(turn.tools.includes("sessions")
      ? [
          { tool: "sessions", args: { action: "list" } },
          { tool: "sessions", args: { action: "new", text: "draft the memo", title: "Memo" } },
          {
            tool: "sessions",
            args: { action: "send_message", target: turn.started.at(-1)?.id, text: "add a summary" },
          },
        ]
      : []),
    ...(subagent ? [] : [{ tool: "subagents", args: { action: "open", task: "repeat what your parent did" } }]),
  ];
  return calls[turn.results.length];
}

test("the sessions tool lists, starts and messages sessions through the real tool context", async () => {
  const w = await world([], script);
  const { parent } = await w.parentTurn("web", "web:U1:sessions");
  assert.equal(parent.results.length, 4);
  assert.deepEqual(parent.results.map(failed), [false, false, false, false], JSON.stringify(parent.results));
});

for (const [surface, flags] of [
  ["web", []],
  ["slack", ["responsive_spine"]],
] as const) {
  test(`a ${surface} subagent can do what its parent could, except SUBAGENT_EXCEPTIONS`, async () => {
    const w = await world([...flags], script);
    const { parent, child } = await w.parentTurn(surface, `${surface}:U1:parity`);
    const omit = (options: AgentToolsOptions) =>
      Object.fromEntries(Object.entries(options).filter(([key]) => !(key in SUBAGENT_EXCEPTIONS)));
    assert.deepEqual(omit(child.options), omit(parent.options));
    assert.deepEqual(
      parent.options.mcpTools?.map((tool) => tool.name),
      ["orders_search"],
      "the turn's actor gets the MCP tools resolved for them",
    );
    assert.equal(parent.ref.current?.humanTurn, true);
    assert.equal(child.ref.current?.humanTurn, undefined);
    assert.equal(parent.requestedRuntime?.fastMode, true);
    assert.equal(child.requestedRuntime?.fastMode, undefined);
    const asParent = { ...child.options, ...Object.fromEntries(exceptions.map((key) => [key, parent.options[key]])) };
    assert.deepEqual(
      createAgentTools(createTurnToolState(child.ref), asParent)
        .map((t) => t.name)
        .sort(),
      parent.tools,
    );
    assert.deepEqual(
      child.results.map(failed),
      parent.results.slice(0, child.results.length).map(failed),
      JSON.stringify(child.results),
    );
  });
}

test("human-descended tasks cannot finish silently without surface tools", async () => {
  const w = await world([], (turn, child) => {
    if (turn.results.length) return;
    return child
      ? { tool: "finish_silently", args: {} }
      : { tool: "subagents", args: { action: "open", task: "report the result" } };
  });
  const { child } = await w.parentTurn("web", "web:U1:silence");
  assert.equal(child.results[0]?.isError, true);
});

test("human-descended tasks can change their runtime but not scope defaults", async () => {
  const w = await world([], script);
  const { parent, child } = await w.parentTurn("web", "web:U1:runtime");
  const active = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };
  assert.ok(child.runtime);
  assert.equal((await child.runtime(active, { action: "set", model: "Astra", lifetime: "task" })).ok, true);
  assert.deepEqual(await child.runtime(active, { action: "set", model: "Astra", lifetime: "scope" }), {
    ok: false,
    error: "live_actor_required",
  });
  assert.equal((await parent.runtime!(active, { action: "set", model: "Astra", lifetime: "scope" })).ok, true);
});
