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
import { createDeliveryStore, turnDeliveryProvenance } from "../src/delivery/delivery-store.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import { type Item, type NewItem, USER_ITEM_KINDS } from "../src/sessions/items.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { orchestratorTestDeps } from "./support/orchestrator-deps.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:retry", audience: [actor] };
scopeId("personal", "U1");

const ASK = "where is that running?";

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

function buildScenario(interruptAfterToolResult = false) {
  const turns: string[] = [];
  const continued: Array<boolean | undefined> = [];
  const environments: Array<string | undefined> = [];
  const histories: Item[][] = [];
  const sandbox = fakeSandbox();
  const agent: Agent = {
    async runTurn(turn) {
      histories.push([...turn.history]);
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
  };
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const deliveries = createDeliveryStore();
  const orchestrator = createOrchestrator({
    ...orchestratorTestDeps(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    resolution: createResolutionService(ORG, testConfigStore(ORG), acl),
    config: testConfigStore(ORG),
    sessions,
    runs,
    files: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
    sandbox,
    auditLog,
    agent,
    memory: createPostgresMemoryService(testDatabaseUrl()),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "retry-replay-deploy"),
      auditLog,
      acl,
    }),
    acl,
    deliveries,
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
      (item) => USER_ITEM_KINDS.includes(item.kind) && (item.text ?? "").startsWith(ASK),
    );
  };
  return {
    orchestrator,
    sessions,
    runs,
    deliveries,
    turns,
    continued,
    environments,
    histories,
    sandbox,
    input,
    asks,
  };
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
  const writer = { sessionId: session.id };
  const boundary = await sessions.append(writer, { kind: "UserMessage", text: ASK });
  await sessions.append(writer, { kind: "UserMessage", text: "a later ask" });
  await sessions.append(writer, { kind: "AgentMessage", text: "answering the later ask" });
  await runs.noteTurnUserSeq(mine.id, boundary.seq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: mine.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.notEqual(retry.reply, "answering the later ask", "the other turn's answer is not replayed as this one's");
  assert.equal(turns.length, 1, "the unanswered turn is resumed rather than silenced");
  assert.equal((await asks()).length, 1, "resuming does not append the ask again");
});

async function seedTurn(sessions: ReturnType<typeof buildScenario>["sessions"], items: NewItem[]): Promise<number> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const writer = { sessionId: session.id };
  let first = -1;
  for (const item of items) {
    const appended = await sessions.append(writer, item);
    if (first < 0) first = appended.seq;
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

test("a resume whose recorded work ends at a tool result asks the agent to continue the assistant turn", async () => {
  const { orchestrator, runs, turns, continued, environments, input, asks } = buildScenario(true);
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await assert.rejects(
    orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 1 })),
    /interrupted after recording a tool result/,
  );

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [undefined, true], "unchanged inventories preserve assistant continuation");
  assert.doesNotMatch(environments[1]!, /## Where you are|Environment changes/);
  assert.equal(turns[1], ASK, "only the original request travels, as the agent's fallback");
  assert.equal((await asks()).length, 1);
});

test("a resume whose last tool call has no recorded result settles it and continues the assistant turn", async () => {
  const { orchestrator, sessions, runs, turns, continued, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const marker = await seedTurn(sessions, [
    { kind: "UserMessage", text: ASK },
    { kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } },
  ]);
  await runs.noteTurnUserSeq(run.id, marker);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.deepEqual(continued, [true]);
  assert.equal(turns[0], ASK, "only the original request travels, as the agent's fallback");
  const settled = (await sessions.getItems((await sessions.getByThread(conversation.threadRef))!.id)).find(
    (item) => item.kind === "ToolResult",
  );
  assert.ok(settled);
  assert.match(settled.text ?? "", /^\[system\] This call was interrupted/);
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

test("a turn that overtakes a paused one shares its history, and the paused turn resumes after it with a note", async () => {
  const { orchestrator, runs, turns, continued, histories, input } = buildScenario(true);
  const shape = (items: Item[]) => items.map((e) => `${e.kind}:${e.callId ?? e.text}`);
  const paused = (await runs.enqueue({ sessionId: conversation.threadRef, request: input("nightly report") })).run;
  await assert.rejects(
    orchestrator.handleTurn(input("nightly report", { runId: paused.id, attempt: 1 })),
    /interrupted/,
  );

  const person = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  assert.equal((await orchestrator.handleTurn(input(ASK, { runId: person.id, attempt: 1 }))).status, "ok");
  assert.deepEqual(
    shape(histories[1]!),
    ["UserMessage:nightly report", "ToolCall:c1", "ToolResult:c1"],
    "the person's turn sees the paused turn's work so far",
  );

  assert.equal((await orchestrator.handleTurn(input("nightly report", { runId: paused.id, attempt: 2 }))).status, "ok");
  assert.deepEqual(continued, [undefined, undefined, undefined], "the paused turn is prompted, not silently continued");
  assert.match(
    turns[2]!,
    /^\[system\] This turn paused while another turn ran in this conversation\..*Original task: nightly report$/,
  );
  assert.deepEqual(shape(histories[2]!), [
    "UserMessage:nightly report",
    "ToolCall:c1",
    "ToolResult:c1",
    `UserMessage:${ASK}`,
    "AgentMessage:it runs on this conversation's computer",
  ]);
});

const slackThread = "ch:C1:100.1";
const slackInput = (runId: string, attempt: number): OrchestratorInput =>
  ({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: slackThread, channelRef: "C1", audience: [actor] } as Conversation,
    deliveryTarget: "slack:C1:100.1",
    origin: { kind: "direct" },
    text: ASK,
    surfaceTools: true,
    addressed: true,
    runId,
    attempt,
  }) as OrchestratorInput;

async function seedSlackTurn(
  scenario: ReturnType<typeof buildScenario>,
  runId: string,
  items: NewItem[],
): Promise<number> {
  const session = await scenario.sessions.getOrCreateByThread(slackThread, "channel", "channel:C1");
  const appended = await scenario.sessions.appendMany({ sessionId: session.id, turnId: runId }, items);
  await scenario.runs.noteTurnUserSeq(runId, appended[0]!.seq);
  return appended[0]!.seq;
}

const ANSWER = "it runs on this conversation's computer";

test("a retried surface-tool turn does not post the reply its first attempt already delivered", async () => {
  const { orchestrator, runs, deliveries, turns } = buildScenario();
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;

  assert.equal((await orchestrator.handleTurn(slackInput(run.id, 1))).status, "silent");
  const delivered = await deliveries.pending("slack");
  assert.deepEqual(
    delivered.map((d) => d.text),
    [ANSWER],
    "the first attempt delivers the reply itself",
  );

  const retry = await orchestrator.handleTurn(slackInput(run.id, 2));
  assert.equal(retry.status, "silent", "the surface's own reply path gets nothing to post again");
  assert.equal(retry.reply, undefined);
  assert.equal(turns.length, 1, "the model is not asked to answer again");
  assert.deepEqual(await deliveries.pending("slack"), delivered, "the thread still has exactly one reply");
});

test("a retried surface-tool turn delivers a recorded reply its first attempt died before sending, once", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, deliveries, turns } = scenario;
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;
  await seedSlackTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: ANSWER },
  ]);

  assert.equal((await orchestrator.handleTurn(slackInput(run.id, 2))).status, "silent");
  assert.equal((await orchestrator.handleTurn(slackInput(run.id, 3))).status, "silent");
  assert.deepEqual(
    (await deliveries.pending("slack")).map((d) => d.text),
    [ANSWER],
    "the reply is delivered once across repeated retries",
  );
  assert.equal(turns.length, 0);
});

test("a retried surface-tool turn does not repeat the acknowledgement its first attempt already posted", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, deliveries } = scenario;
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;
  await seedSlackTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: `Checking now. ${ANSWER}` },
  ]);
  await deliveries.enqueue({
    destination: { type: "slack", target: "C1:100.1" },
    text: "Checking now.",
    idempotencyKey: `ack:${run.id}`,
    provenance: turnDeliveryProvenance({
      origin: { kind: "direct" },
      surface: "slack",
      fireKey: `ack:${run.id}`,
      sourceScopeId: scopeId("channel", "C1"),
      sourceThreadRef: slackThread,
    }),
  });

  assert.equal((await orchestrator.handleTurn(slackInput(run.id, 2))).status, "silent");
  assert.deepEqual(
    (await deliveries.pending("slack")).map((d) => d.text),
    ["Checking now.", ANSWER],
    "the replayed reply leaves out the acknowledgement already in the thread",
  );
});

test("a retried surface-tool turn whose model already posted does not deliver its trailing text", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, deliveries, turns } = scenario;
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;
  await seedSlackTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "ToolCall", tool: "slack", callId: "p1", body: { action: "post", text: "posted answer" } },
    { kind: "ToolResult", tool: "slack", callId: "p1", text: "[sent]", body: { action: "post", ok: true } },
    { kind: "AgentMessage", text: "trailing text the surface-tool rules withhold" },
  ]);

  const retry = await orchestrator.handleTurn(slackInput(run.id, 2));
  assert.equal(retry.status, "silent");
  assert.equal(retry.reply, undefined);
  assert.deepEqual(await deliveries.pending("slack"), []);
  assert.equal(turns.length, 0);
});

async function seedWebTurn(scenario: ReturnType<typeof buildScenario>, runId: string, items: NewItem[]) {
  const session = await scenario.sessions.getOrCreateByThread(conversation.threadRef, "dm", "personal:U1");
  const appended = await scenario.sessions.appendMany({ sessionId: session.id, turnId: runId }, items);
  await scenario.runs.noteTurnUserSeq(runId, appended[0]!.seq);
}

test("a retry of a person-stopped turn replays the stop with its partial, as the first attempt reported it", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, turns, input } = scenario;
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await seedWebTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: "it runs on", body: { stopped: true } },
    { kind: "Stop", body: { reason: "by user" } },
  ]);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.stopped, true, "the replay keeps the stop the first attempt recorded");
  assert.equal(retry.reply, "it runs on", "the partial is reported as a stopped reply, not a finished one");
  assert.equal(turns.length, 0, "the stopped turn is not run again");
});

test("a retry of a turn stopped by its run being cancelled replays silent and stopped", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, turns, input } = scenario;
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  await seedWebTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: "it runs on", body: { stopped: true, cancelled: true } },
    { kind: "Stop", body: { reason: "because the run was cancelled" } },
  ]);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "silent", "the cancelled partial is not handed out as a reply");
  assert.equal(retry.stopped, true);
  assert.equal(turns.length, 0);
});

test("a retried surface-tool turn does not re-send a reply its first attempt delivered through the fallback post", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, deliveries, turns } = scenario;
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;
  await seedSlackTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: ANSWER },
  ]);
  const destination = { type: "slack", target: "slack:C1:100.1" };
  const fallbackKey = turnPostKeys(run.id).key(destination, 1);
  await deliveries.enqueue({ destination, text: ANSWER, idempotencyKey: fallbackKey });

  assert.equal((await orchestrator.handleTurn(slackInput(run.id, 2))).status, "silent");
  assert.deepEqual(
    (await deliveries.pending("slack")).map((d) => d.idempotencyKey),
    [fallbackKey],
    "the reply already sent as the fallback is not sent again",
  );
  assert.equal(turns.length, 0);
});

test("a retry of a stopped surface-tool turn stays silent, keeps the stop, and posts nothing", async () => {
  const scenario = buildScenario();
  const { orchestrator, runs, deliveries, turns } = scenario;
  const run = (await runs.enqueue({ sessionId: slackThread, request: slackInput("", 1) })).run;
  await seedSlackTurn(scenario, run.id, [
    { kind: "UserMessage", text: ASK },
    { kind: "AgentMessage", text: "it runs on", body: { stopped: true } },
    { kind: "Stop", body: { reason: "because the run was cancelled" } },
  ]);

  const retry = await orchestrator.handleTurn(slackInput(run.id, 2));
  assert.equal(retry.status, "silent");
  assert.equal(retry.stopped, true);
  assert.equal(turns.length, 0);
  assert.deepEqual(await deliveries.pending("slack"), []);
});
