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
import type { Conversation, Principal } from "../src/types.ts";

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

test("revocation removes recalled memory from replay, summaries, tape and history reopening across restart", async () => {
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
  let orch = buildOrchestrator(harness, memory, sessions);
  const first = await orch.handleTurn(dm("memory-revoke", "!sysprompt"));
  assert.equal(first.status, "ok");
  assert.match(seen[0]!.environment ?? "", /PRIVATE_SENTINEL/);
  const session = (await sessions.getByThread("memory-revoke"))!;
  const lease = (await sessions.acquireLease(session.id)).lease!;
  await sessions.append(lease, {
    type: "system",
    scopeLabel: "personal:U1",
    payload: {
      kind: "context_summary",
      throughSeq: await sessions.latestEntrySeq(session.id),
      text: "PRIVATE_SENTINEL summarized",
    },
  });
  await sessions.appendTape(lease, {
    kind: "message",
    scopeLabel: "personal:U1",
    payload: { role: "assistant", content: [{ type: "text", text: "PRIVATE_SENTINEL" }] },
  });
  await sessions.releaseLease(lease);
  content = "";
  orch = buildOrchestrator(harness, memory, sessions);
  const second = await orch.handleTurn({
    ...dm("memory-revoke", "safe second request"),
    priorTurns: [{ role: "assistant", text: "PRIVATE_SENTINEL" }],
  });
  assert.equal(second.status, "ok");
  assert.doesNotMatch(
    JSON.stringify({
      history: seen[1]!.history,
      environment: seen[1]!.environment,
      tape: seen[1]!.tape,
      priorTurns: seen[1]!.priorTurns,
    }),
    /PRIVATE_SENTINEL/,
  );
  assert.deepEqual(reopened[1], []);
  assert.ok(resets > 0);
  const third = await orch.handleTurn(dm("memory-revoke", "safe third request"));
  assert.equal(third.status, "ok");
  assert.doesNotMatch(JSON.stringify(seen[2]!.history), /PRIVATE_SENTINEL/);
  assert.match(JSON.stringify(seen[2]!.history), /safe second request/);
  assert.match(JSON.stringify(await sessions.getEntries(session.id)), /PRIVATE_SENTINEL/);
});

for (const operation of ["read", "search"] as const)
  test(`a memory ${operation} outside the starting snapshot forces a durable reset next turn`, async () => {
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
    assert.doesNotMatch(JSON.stringify(seen[1]!.history), /TRANSIENT_SENTINEL/);
    const session = (await sessions.getByThread("transient-memory"))!;
    assert.equal(await sessions.memoryReadEpoch(session.id), 1);
    assert.match(JSON.stringify(await sessions.getEntries(session.id)), /TRANSIENT_SENTINEL/);
  });
