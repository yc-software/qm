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
import { harnessToolOptions } from "../src/harness/harness-shared.ts";
import { createAgentTools, SUBAGENT_TOOL_EXCEPTIONS, type AgentToolsOptions } from "../src/harness/agent-tools.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureName } from "../src/feature-flags.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { scopeId, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Run } from "../src/runs/run-store.ts";

type Call = { tool: string; args: Record<string, unknown> };
type Turn = {
  ref: Parameters<typeof createAgentTools>[0];
  options: AgentToolsOptions;
  tools: string[];
  results: string[];
};

const actor: Principal = { id: "U1", type: "internal" };
const scope = scopeId("personal", "U1");
const exceptions = Object.keys(SUBAGENT_TOOL_EXCEPTIONS) as (keyof AgentToolsOptions)[];

function noSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("these turns never touch a computer");
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

async function world(flags: FeatureName[], next: (turn: Turn, subagent: boolean) => Call | undefined) {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const featureFlags = createFeatureFlagStore(createMemoryMap());
  for (const flag of flags) await featureFlags.setEnabled(flag, scope, true, "test");
  const sidebar: Awaited<ReturnType<typeof sessions.get>>[] = [];
  const sessionSyscalls = createSessionSyscalls({
    sessions,
    runs,
    mailbox: createSessionMailbox(createMemoryMap<SessionMessage>()),
    signals: createMemoryRunSignalStore(),
    maxAttempts: 1,
    conversations: {
      list: async () => sidebar.filter((session) => session !== null),
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
        const ref = {
          current: turn.tools,
          scopeLabel: turn.scopeLabel,
          emit: turn.emit,
          screenToolResult: turn.screenToolResult,
          pendingApprovals: [],
        };
        const options = harnessToolOptions({}, turn);
        const tools = createAgentTools(ref, options);
        const record: Turn = { ref, options, tools: tools.map((t) => t.name).sort(), results: [] };
        turns.set(turn.session.threadRef, record);
        for (
          let call = next(record, !!turn.session.parentSessionId);
          call;
          call = next(record, !!turn.session.parentSessionId)
        ) {
          const execute = tools.find((t) => t.name === call.tool)!.execute as unknown as (
            id: string,
            input: unknown,
          ) => Promise<{ content: { text?: string }[] }>;
          const out = await execute(`call-${record.results.length}`, call.args);
          record.results.push(out.content.map((c) => c.text ?? "").join(""));
        }
        return { reply: "done", modelCalls: 1 };
      },
    },
  );
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "subagent-parity-")));
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService("org", createMemoryConfigStore("org"), acl),
    sessions,
    runs,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: noSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy: createDeployService({
      deployStore: createDeployStore(),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "subagent-parity-deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries: createDeliveryStore(),
    featureFlags,
    sessionSyscalls,
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

const failed = (result: string) => result.includes("[error]");
const startedId = (result: string) => /sessionId ([0-9a-f-]{36})/.exec(result)?.[1] ?? "";

function script(turn: Turn, subagent: boolean): Call | undefined {
  const calls: Call[] = [
    ...(turn.tools.includes("sessions")
      ? [
          { tool: "sessions", args: { action: "list" } },
          { tool: "sessions", args: { action: "new", text: "draft the memo", title: "Memo" } },
          {
            tool: "sessions",
            args: { action: "send_message", target: startedId(turn.results[1] ?? ""), text: "add a summary" },
          },
        ]
      : []),
    ...(subagent ? [] : [{ tool: "subagents", args: { action: "open", task: "repeat what your parent did" } }]),
  ];
  return calls[turn.results.length];
}

test("the sessions tool lists, starts and messages sessions through the real tool context", async () => {
  const w = await world(["persistent_subagents"], script);
  const { parent } = await w.parentTurn("web", "web:U1:sessions");
  assert.equal(parent.results.length, 4);
  assert.deepEqual(parent.results.map(failed), [false, false, false, false], parent.results.join("\n"));
});

for (const [surface, flags] of [
  ["web", ["persistent_subagents"]],
  ["slack", ["responsive_spine"]],
] as const) {
  test(`a ${surface} subagent can do what its parent could, except SUBAGENT_TOOL_EXCEPTIONS`, async () => {
    const w = await world([...flags], script);
    const { parent, child } = await w.parentTurn(surface, `${surface}:U1:parity`);
    const omit = (options: AgentToolsOptions) =>
      Object.fromEntries(Object.entries(options).filter(([key]) => !(key in SUBAGENT_TOOL_EXCEPTIONS)));
    assert.deepEqual(omit(child.options), omit(parent.options));
    const asParent = { ...child.options, ...Object.fromEntries(exceptions.map((key) => [key, parent.options[key]])) };
    assert.deepEqual(
      createAgentTools(child.ref, asParent)
        .map((t) => t.name)
        .sort(),
      parent.tools,
    );
    assert.deepEqual(
      child.results.map(failed),
      parent.results.slice(0, child.results.length).map(failed),
      child.results.join("\n"),
    );
  });
}
