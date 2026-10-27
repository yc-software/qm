import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../../../src/core/orchestrator.ts";
import { createIdentityService } from "../../../src/identity/identity-service.ts";
import { createAclStore } from "../../../src/acl/acl-store.ts";
import { createResolutionService } from "../../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../../../src/files/durable-byte-store.ts";
import { createModelGateway } from "../../../src/model/model-gateway.ts";
import { defineHarness } from "../../../src/harness/harness.ts";
import { createDeployStore } from "../../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../../src/deploy/deploy-service.ts";
import { recordingOutbound } from "../../support/recording-outbound.ts";
import { scopeId, type Conversation, type Principal } from "../../../src/types.ts";
import type { Item, NewItem } from "../../../src/sessions/items.ts";
import type { Sandbox } from "../../../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "../../support/single-process.ts";
import { createPostgresAuditLog } from "../../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "../../support/test-database.ts";
import { createPostgresGrantStore } from "../../../src/acl/postgres-grant-store.ts";
import { testRunStore } from "../../support/turns.ts";

const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:retry", audience: [actor] };
scopeId("personal", "U1");

const ASK = "where is that running?";

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the retry-replay tests must not provision a sandbox");
  };
  return {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: false },
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

function buildScenario(interruptAfterToolResult = false) {
  const databaseUrl = testDatabaseUrl();
  const turns: string[] = [];
  const continued: Array<boolean | undefined> = [];
  const environments: Array<string | undefined> = [];
  const sandbox = fakeSandbox();
  const harness = defineHarness({
    async runTurn(turn) {
      turns.push(turn.input);
      continued.push(turn.continueTurn);
      environments.push(turn.environment);
      if (!turn.continueTurn) await turn.emit({ kind: "UserMessage", text: turn.input });
      if (interruptAfterToolResult && turns.length === 1) {
        await turn.emit({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } });
        await turn.emit({ kind: "ToolResult", tool: "execute", callId: "c1", text: "a.txt" });
        throw new Error("interrupted after recording a tool result");
      }
      const reply = "it runs on this conversation's computer";
      await turn.emit({ kind: "AgentMessage", text: reply });
      return { reply, modelCalls: 1 };
    },
    async screenSecurity() {
      return { decision: "auto" as const };
    },
  });
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = testRunStore();
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "retry-replay-")));
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(testConfigStore(), acl),
    sessions,
    runs,
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(databaseUrl),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "retry-replay-deploy"),
      auditLog,
      acl,
    }),
    acl,
    outbound: recordingOutbound(),
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "web",
    actor,
    conversation,
    origin: { kind: "human" },
    text,
    ...extra,
  });
  const asks = async (): Promise<Item[]> => {
    const session = (await sessions.getByThread(conversation.threadRef))!;
    return (await sessions.getItems(session.id, { limit: 200 })).filter(
      (e) => e.kind === "UserMessage" && (e.text ?? "").startsWith(ASK),
    );
  };
  return { orchestrator, sessions, runs, turns, continued, environments, sandbox, input, asks };
}

test("a retry replays the answer the previous attempt recorded instead of asking again", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;

  const first = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 }));
  assert.equal(first.status, "ok");
  assert.equal((await asks()).length, 1, "the first attempt recorded the ask once");
  const boundary = (await runs.get(run.id))?.turnUserSeq;
  assert.equal(typeof boundary, "number", "the attempt recorded its turn boundary against the run");

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok", "the reaped run completes instead of re-answering");
  assert.equal(retry.reply, "it runs on this conversation's computer", "the recorded answer is replayed, not lost");
  assert.equal(retry.sourceUserSeq, boundary, "the replay points at the turn the answer belongs to");
  assert.equal(typeof retry.sourceAssistantEntrySeq, "number", "the replay names the recorded answer entry");
  assert.equal((await asks()).length, 1, "the ask is not appended a second time");
  assert.equal(turns.length, 1, "the model is not asked to answer twice");
  assert.equal((await runs.get(run.id))?.turnUserSeq, boundary, "the boundary is not moved by the retry");
});

test("a retry with no recorded boundary runs the turn, so a lost attempt never drops the ask", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok", "an attempt that died before recording anything still answers");
  assert.equal((await asks()).length, 1);
  assert.equal(turns.length, 1);
});

test("a repeated identical ask in its own run is answered, not mistaken for a replay", async () => {
  const { orchestrator, runs, turns, input, asks } = buildScenario();
  const first = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: first.id, attempt: 1 }));

  const second = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const again = await orchestrator.handleTurn(input(ASK, { runId: second.id, attempt: 2 }));

  assert.equal(again.status, "ok", "a different run's retry is not silenced by the earlier answer");
  assert.equal((await asks()).length, 2);
  assert.equal(turns.length, 2);
});

test("a retry does not claim a later message's answer as its own", async () => {
  const { orchestrator, sessions, runs, turns, input, asks } = buildScenario();
  const mine = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const { lease } = await sessions.acquireLease(session.id);
  const boundary = await sessions.append(lease!, { kind: "UserMessage", text: ASK });
  await sessions.append(lease!, { kind: "UserMessage", text: "a later ask" });
  await sessions.append(lease!, { kind: "AgentMessage", text: "answering the later ask" });
  await sessions.releaseLease(lease!);
  await runs.noteTurnUserSeq(mine.id, boundary.seq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: mine.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.notEqual(retry.reply, "answering the later ask", "the other turn's answer is not replayed as this one's");
  assert.equal(turns.length, 1, "the unanswered turn is resumed rather than silenced");
  assert.equal((await asks()).length, 1, "resuming does not append the ask again");
});

test("the replay does not need the session lease, so a busy session cannot requeue it again", async () => {
  const { orchestrator, sessions, runs, turns, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 }));

  const session = (await sessions.getByThread(conversation.threadRef))!;
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease, "something else now holds the session");
  try {
    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok", "the replay is not refused as session_busy");
    assert.equal(retry.reply, "it runs on this conversation's computer");
    assert.equal(turns.length, 1);
  } finally {
    await sessions.releaseLease(lease!);
  }
});

async function seedTurn(sessions: ReturnType<typeof buildScenario>["sessions"], items: NewItem[]): Promise<number> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const { lease } = await sessions.acquireLease(session.id);
  let first = -1;
  try {
    for (const item of items) {
      const appended = await sessions.append(lease!, item);
      if (first < 0) first = appended.seq;
    }
  } finally {
    await sessions.releaseLease(lease!);
  }
  return first;
}

test("a steer mid-turn does not make an answered turn look unanswered", async () => {
  const { orchestrator, sessions, runs, turns, input, asks } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { kind: "UserMessage", text: ASK },
    { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } },
    { kind: "SteeringMessage", text: "also check the log", body: { ts: "1" } },
    { kind: "AgentMessage", text: "checked both" },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(retry.reply, "checked both", "the steered turn's own answer is replayed");
  assert.equal(turns.length, 0, "the model is not asked to answer the steered turn again");
  assert.equal((await asks()).length, 1, "the ask is not appended again");
});

test("a turn that recorded no reply replays as silent, not as an empty answer", async () => {
  const { orchestrator, sessions, runs, turns, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: "" },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "silent", "an empty reply must not surface as a turn with no response");
  assert.equal(retry.reply, undefined);
  assert.equal(turns.length, 0);
});

test("a resume whose recorded work ends at a tool result asks the harness to continue the assistant turn", async () => {
  const { orchestrator, runs, turns, continued, environments, input, asks } = buildScenario(true);
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await assert.rejects(
    orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 })),
    /interrupted after recording a tool result/,
  );
  const original = (await asks())[0]!;
  assert.ok(original.body.environmentSnapshot);
  assert.match(environments[0]!, /## Where you are/);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined, true], "unchanged inventories preserve assistant continuation");
  assert.doesNotMatch(environments[1]!, /## Where you are|Environment changes/);
  assert.equal(turns[1], ASK, "only the original request travels, as the harness's fallback");
  assert.equal((await asks()).length, 1);
});

test("a changed inventory on retry reaches the model instead of continuing past the update", async () => {
  const { orchestrator, runs, turns, continued, environments, sandbox, input, asks } = buildScenario(true);
  sandbox.profile.spec = { os: "Old Linux" };
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await assert.rejects(
    orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 })),
    /interrupted after recording a tool result/,
  );
  assert.match(environments[0]!, /Old Linux/);
  sandbox.profile.spec = { os: "New Linux" };

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined, undefined], "the new user message carries changed inventory");
  assert.equal(turns[1], "", "the request is not re-sent with the changed inventory");
  assert.match(environments[1]!, /Environment changes/);
  assert.match(environments[1]!, /New Linux/);
  assert.doesNotMatch(environments[1]!, /Old Linux|## Where you are/);
  assert.equal((await asks()).length, 1);
});

test("a resume whose last tool call has no recorded result settles it and does not re-send the request", async () => {
  const { orchestrator, sessions, runs, turns, continued, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { kind: "UserMessage", text: ASK },
    { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined], "the seeded turn has no recorded environment, so its context is sent");
  assert.equal(turns[0], "");
  const settled = (await sessions.getItems((await sessions.getByThread(conversation.threadRef))!.id)).find(
    (e) => e.kind === "ToolResult",
  );
  assert.ok(settled);
  assert.match(String(settled.text), /^\[system\] This call was interrupted/);
});

test("a first attempt and a no-work retry are never asked to continue", async () => {
  const { orchestrator, runs, continued, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 }));
  const again = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await orchestrator.handleTurn(input(ASK, { runId: again.id, attempt: 2 }));
  assert.deepEqual(continued, [undefined, undefined]);
});

test("a retry resumes its own interrupted turn even when the run never recorded its boundary", async () => {
  const { orchestrator, runs, continued, input, asks } = buildScenario(true);
  runs.noteTurnUserSeq = async () => false;
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await assert.rejects(orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 })), /interrupted/);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined, true]);
  assert.equal((await asks()).length, 1);
});

test("a retry does not resume another run's interrupted turn that asked the same thing", async () => {
  const { orchestrator, runs, continued, input, asks } = buildScenario(true);
  const first = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await assert.rejects(orchestrator.handleTurn(input(ASK, { runId: first.id, attempt: 1 })), /interrupted/);

  const second = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const retry = await orchestrator.handleTurn(input(ASK, { runId: second.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined, undefined]);
  assert.equal((await asks()).length, 2);
});
