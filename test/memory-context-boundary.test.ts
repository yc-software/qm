import { test } from "node:test";
import { buildMemoryContextSnapshot, nextMemoryContext } from "../src/memory/context-boundary.ts";
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
import { createMemoryService } from "../src/memory/memory-service.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { HarnessTurnInput, Harness } from "../src/harness/harness.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal, SessionEntry } from "../src/types.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const dm = (thread: string, text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  origin: { kind: "direct" },
  text,
});

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational memory turn must not touch the sandbox");
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

function buildOrchestrator(harness: Harness, memory: MemoryService, sessions = createMemorySessionStore()) {
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "mca-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "mca-deploy"),
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
    harness,
    memory: memory ?? createMemoryService(workspace),
    memoryStrategy: {},
    deploy,
    acl,
  });
}

for (const change of ["source", "audience"] as const)
  test(`${change} change ${change === "source" ? "preserves" : "isolates"} retained memory across restart`, async () => {
    const sessions = createMemorySessionStore();
    let content = "- PRIVATE_SENTINEL";
    const memory: MemoryService = {
      read: async () => content,
      query: async () => [content],
      recall: async () => content,
      capture: async () => 0,
      replace: async () => {},
    };
    const seen: HarnessTurnInput[] = [];
    const reopened: unknown[] = [];
    let resets = 0;
    const base = createMockHarness();
    const harness: Harness = {
      ...base,
      turns: {
        ...base.turns,
        resetSession: async () => {
          resets++;
        },
        runTurn: async (turn) => {
          seen.push(turn);
          reopened.push(await turn.tools.history("PRIVATE_SENTINEL"));
          return base.turns.runTurn(turn);
        },
      },
    };
    let audience: Principal[] = [actor, { id: "U2", type: "internal" }];
    const input = (text: string): OrchestratorInput => ({
      ...dm("memory-boundary", text),
      conversation: { kind: "group", channelRef: "room", threadRef: "memory-boundary", audience },
    });
    let orch = buildOrchestrator(harness, memory, sessions);
    const first = await orch.handleTurn(input("!sysprompt"));
    assert.equal(first.status, "ok");
    assert.match(seen[0]!.environment ?? "", /PRIVATE_SENTINEL/);
    const session = (await sessions.getByThread("memory-boundary"))!;
    const lease = (await sessions.acquireLease(session.id)).lease!;
    await sessions.append(lease, {
      type: "system",
      scopeLabel: session.scopeId,
      payload: {
        kind: "context_summary",
        throughSeq: await sessions.latestEntrySeq(session.id),
        text: "PRIVATE_SENTINEL summarized",
      },
    });
    await sessions.appendTape(lease, {
      kind: "message",
      scopeLabel: session.scopeId,
      payload: { role: "assistant", content: [{ type: "text", text: "PRIVATE_SENTINEL" }] },
    });
    await sessions.releaseLease(lease);
    content = "";
    if (change === "audience") audience = [...audience, { id: "U3", type: "internal" }];
    orch = buildOrchestrator(harness, memory, sessions);
    const second = await orch.handleTurn({
      ...input("safe second request"),
      priorTurns: [{ role: "assistant", text: "PRIVATE_SENTINEL" }],
    });
    assert.equal(second.status, "ok");
    assert.doesNotMatch(seen[1]!.environment ?? "", /PRIVATE_SENTINEL/);
    const retained = JSON.stringify({
      history: seen[1]!.history,
      tape: seen[1]!.tape,
      priorTurns: seen[1]!.priorTurns,
    });
    if (change === "source") {
      assert.match(retained, /PRIVATE_SENTINEL/);
      assert.match(JSON.stringify(reopened[1]), /PRIVATE_SENTINEL/);
      assert.equal(resets, 0);
    } else {
      assert.doesNotMatch(retained, /PRIVATE_SENTINEL/);
      assert.deepEqual(reopened[1], []);
      assert.equal(resets, 1);
    }
    const third = await orch.handleTurn({ ...input("safe third request"), actor: audience[1]! });
    assert.equal(third.status, "ok");
    if (change === "audience") assert.doesNotMatch(JSON.stringify(seen[2]!.history), /PRIVATE_SENTINEL/);
    else assert.match(JSON.stringify(seen[2]!.history), /PRIVATE_SENTINEL/);
    assert.match(JSON.stringify(seen[2]!.history), /safe second request/);
    assert.equal(resets, change === "audience" ? 1 : 0);
    assert.match(JSON.stringify(await sessions.getEntries(session.id)), /PRIVATE_SENTINEL/);
  });

for (const operation of ["read", "search"] as const)
  test(`a memory ${operation} outside the starting snapshot preserves context next turn`, async () => {
    const sessions = createMemorySessionStore();
    let content = "- original";
    const memory: MemoryService = {
      read: async () => content,
      query: async () => [content],
      recall: async () => content,
      capture: async () => 0,
      replace: async () => {},
    };
    const base = createMockHarness();
    const seen: HarnessTurnInput[] = [];
    const harness: Harness = {
      ...base,
      turns: {
        ...base.turns,
        runTurn: async (turn) => {
          seen.push(turn);
          if (seen.length === 1) {
            content = "- TRANSIENT_SENTINEL";
            const result =
              operation === "read" ? await turn.tools.memoryRead() : await turn.tools.memorySearch("SENTINEL");
            await turn.emit({ type: "tool_result", scopeLabel: turn.scopeLabel, payload: { text: result } });
          }
          return base.turns.runTurn(turn);
        },
      },
    };
    const orch = buildOrchestrator(harness, memory, sessions);
    assert.equal((await orch.handleTurn(dm("transient-memory", "first"))).status, "ok");
    content = "- original";
    assert.equal((await orch.handleTurn(dm("transient-memory", "second"))).status, "ok");
    assert.match(JSON.stringify(seen[1]!.history), /TRANSIENT_SENTINEL/);
    const session = (await sessions.getByThread("transient-memory"))!;
    assert.match(JSON.stringify(await sessions.getEntries(session.id)), /TRANSIENT_SENTINEL/);
  });

for (const change of ["audience", "type", "scope"] as const)
  test(`an empty-memory checkpoint still isolates a changed ${change}`, () => {
    const before = buildMemoryContextSnapshot({ targetScope: "group:room", audience: [actor] });
    let audience: Principal[] = [actor];
    if (change === "audience") audience = [actor, { id: "U2", type: "internal" }];
    if (change === "type") audience = [{ ...actor, type: "guest" }];
    const after = buildMemoryContextSnapshot({
      targetScope: change === "scope" ? "group:other" : "group:room",
      audience,
    });
    const checkpoint = nextMemoryContext([], before, -1);
    const entries: SessionEntry[] = [
      {
        sessionId: "synthetic",
        parentSeq: null,
        seq: 0,
        type: "system",
        scopeLabel: "group:room",
        createdAt: 1,
        payload: checkpoint,
      },
    ];
    assert.equal(nextMemoryContext(entries, after, 5).throughSeq, 5);
    assert.equal(nextMemoryContext(entries, before, 5).throughSeq, -1);
  });

test("audience identity is stable across speaker order and team membership changes", () => {
  const audience: Principal[] = [actor, { id: "U2", type: "internal" }];
  assert.deepEqual(
    buildMemoryContextSnapshot({ targetScope: "group:room", audience }),
    buildMemoryContextSnapshot({
      targetScope: "group:room",
      audience: audience.toReversed().map((p) => ({ ...p, teamIds: ["new-team"] })),
    }),
  );
});

test("a failed audience reset is retried before recording the new checkpoint", async () => {
  const sessions = createMemorySessionStore();
  const memory: MemoryService = {
    read: async () => "",
    query: async () => [],
    recall: async () => "",
    capture: async () => 0,
    replace: async () => {},
  };
  const base = createMockHarness();
  let resets = 0;
  const seen: HarnessTurnInput[] = [];
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      resetSession: async () => {
        if (++resets === 1) throw new Error("synthetic reset failure");
      },
      runTurn: async (turn) => {
        seen.push(turn);
        return base.turns.runTurn(turn);
      },
    },
  };
  const orch = buildOrchestrator(harness, memory, sessions);
  const input: OrchestratorInput = {
    ...dm("reset-retry", "PRIVATE_SENTINEL"),
    conversation: { kind: "group", channelRef: "retry-room", threadRef: "reset-retry", audience: [actor] },
  };
  assert.equal((await orch.handleTurn(input)).status, "ok");
  input.conversation.audience = [actor, { id: "U2", type: "internal" }];
  input.text = "new audience";
  await assert.rejects(orch.handleTurn(input), /synthetic reset failure/);
  assert.equal((await orch.handleTurn(input)).status, "ok");
  assert.equal(resets, 2);
  assert.doesNotMatch(JSON.stringify(seen[1]!.history), /PRIVATE_SENTINEL/);
  assert.equal((await orch.handleTurn({ ...input, text: "stable audience" })).status, "ok");
  assert.equal(resets, 2);
  assert.match(JSON.stringify(seen[2]!.history), /new audience/);
});
