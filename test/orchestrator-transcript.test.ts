import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { freshApp, dm, channel } from "./support/orchestrator-app.ts";
import { runNowSettled, settle } from "./support/settle.ts";
import { failedTurnError } from "./support/failed-turn.ts";
import { isAgentReply, isHidden, isUserItem } from "../src/sessions/items.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("internal DM turn runs end-to-end and records the session", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("hello there"));
  assert.equal(res.status, "ok");
  assert.ok(res.sessionId);
  assert.match(res.reply ?? "", /You said: hello there/);

  const found = await app.getSession(res.sessionId!);
  const kinds = found!.items.map((e) => e.kind);
  assert.deepEqual(kinds, ["UserMessage", "AgentMessage"]);
});

test("human transcript entries retain authenticated identity across duplicate names and renames", async () => {
  const { app } = freshApp();
  for (const actor of [
    { externalId: "U1", displayName: "Alex" },
    { externalId: "U2", displayName: "Alex" },
    { externalId: "U1", displayName: "New Name" },
  ]) {
    const result = await app.turn(channel("hello", { actor, origin: { kind: "human" } }));
    assert.equal(result.status, "ok", result.reason);
    const found = await app.getSession(result.sessionId!);
    const body = found!.items.filter(isUserItem).at(-1)!.body;
    assert.equal(body.speakerId, actor.externalId);
    assert.equal(body.name, actor.displayName);
  }
});

test("the persisted assistant entry carries authoritative turn timing for transcript rendering", async () => {
  const { app } = freshApp();
  const before = Date.now();
  const res = await app.turn(dm("hello timing"));
  assert.equal(res.status, "ok");
  const found = await app.getSession(res.sessionId!);
  const assistant = found!.items.find(isAgentReply);
  const p = assistant!.body as { workStartedAt?: number; workFinishedAt?: number };
  assert.equal(typeof p.workStartedAt, "number", "turn start is persisted");
  assert.equal(typeof p.workFinishedAt, "number", "turn finish is persisted");
  assert.ok(p.workStartedAt! >= before && p.workFinishedAt! >= p.workStartedAt!);
});

test("the deployment turn wall-clock reaches the agent and a per-turn cap replaces it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { app } = freshApp({ turnWallClockMs: 120_000 });
  assert.equal((await app.turn(dm("!wallclock"))).reply, "wallclock:120000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 70_000 }))).reply, "wallclock:70000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 500_000 }))).reply, "wallclock:500000");
  assert.equal((await app.turn(dm("!wallclock", { turnWallClockMs: 0 }))).reply, "wallclock:120000");
  assert.equal((await freshApp().app.turn(dm("!wallclock"))).reply, "wallclock:0");
});

test("inbound file problems reach the model in the environment footer, not a log entry", async () => {
  const { app, sessions } = freshApp();
  const note = 'skipped "screenshot.png" — too many files in one message (max 10)';
  const res = await app.turn(dm("what's your favorite color", { inboundNotes: [note] }));
  assert.equal(res.status, "ok", res.reason);

  const items = await sessions.getItems(res.sessionId!);
  assert.equal(
    items.some(
      (item) =>
        ["Wake", "Error", "ContextCompaction", "Retraction", "Stop", "RuntimeChange"].includes(item.kind) &&
        /screenshot\.png/.test(JSON.stringify(item)),
    ),
    false,
  );
  const user = items.find((item) => item.kind === "UserMessage");
  assert.match(
    String(user!.body.environment),
    /<environment>[\s\S]*did not reach \.\/inbox\/[\s\S]*screenshot\.png[\s\S]*<\/environment>/,
  );

  const reqs = (await sessions.listLlmRequests(res.sessionId!)) as Array<{ model: string; promptEnvelope: unknown }>;
  assert.ok(
    reqs
      .filter((request) => request.model !== "mock-security")
      .some((r) => /screenshot\.png/.test(JSON.stringify(r.promptEnvelope))),
    "the model sees the dropped file",
  );

  assert.equal((res as { fileNotes?: unknown }).fileNotes, undefined);
});

test("a failed turn still records which inbound files did not arrive", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { sessions, errors } = built;
  const note = 'skipped "screenshot.png" — too many files in one message (max 10)';
  await failedTurnError(built, dm("!boom", { inboundNotes: [note] }));
  const { sessionId } = (await errors.list(tenant)).find((e) => e.category === "turn")!;
  const user = (await sessions.getItems(sessionId!)).find((item) => item.kind === "UserMessage");
  assert.match(String(user?.body.environment), /screenshot\.png/);
});

test("a proactive-opener turn greets with no user text and records the seeding entry hidden", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("", { proactiveOpener: true }));
  assert.equal(res.status, "ok", res.reason);
  assert.match(res.reply ?? "", /just opened the app for the first time/);

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
  const userEntry = found!.items.find(isUserItem)!;
  assert.equal(isHidden(userEntry), true, "the opener seed is hidden so no surface renders it");
});

test("a proactiveOpener turn that carries real text keeps the user entry visible", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("actually, here's my real question", { proactiveOpener: true }));
  assert.equal(res.status, "ok", res.reason);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find(isUserItem)!;
  assert.notEqual(isHidden(userEntry), true, "a real typed message stays visible even on an opener-flagged turn");
});

test("a triggered turn records its synthetic wake prompt hidden so the chat never shows it as a user message", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    dm('<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>new output</why></wake>', {
      origin: { kind: "automation" },
    }),
  );
  assert.equal(res.status, "ok", res.reason);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find(isUserItem)!;
  assert.equal(isHidden(userEntry), true, "the wake prompt is hidden so no surface renders it as a user message");
});

test("a 1:1 names the authenticated human in the prompt so the agent never asks who they are", async () => {
  const { app, sessions } = freshApp();
  const res = await app.turn(dm("hi", { actor: { externalId: "ada@acme.com", displayName: "Ada Lovelace" } }));
  assert.equal(res.status, "ok", res.reason);
  const sys = (await sessions.listLlmRequests(res.sessionId!)).at(-1)! as any;
  assert.match(sys.promptEnvelope.system, /live private 1:1 with Ada Lovelace \(ada@acme\.com\)/);
});

test("a channel turn gets no 1:1 identity block", async () => {
  const { app, sessions } = freshApp();
  const res = await app.turn(channel("hi", { actor: { externalId: "U1", displayName: "Ada" } }));
  assert.equal(res.status, "ok", res.reason);
  const sys = (await sessions.listLlmRequests(res.sessionId!)).at(-1)! as any;
  assert.doesNotMatch(sys.promptEnvelope.system, /## Who you're talking to/);
});

test("a silent cron source run stays out of normal human chat history", async () => {
  const built = freshApp();
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() },
    action: "!preamble-then-quiet Posted the digest DM",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "principal", target: "U2", audienceScopeId: scopeId("personal", "U2"), onBehalfOf: "U1" },
  });

  await runNowSettled(built.scheduler, cron.id);

  assert.equal((await built.deliveries.pending("principal")).length, 0, "finish_silently means no delivery");
  const source = (await built.sessions.listByScope(scopeId("personal", "U1"))).find((s) =>
    s.threadRef.startsWith(`cron:${cron.id}:fire:`),
  );
  assert.ok(source, "cron source run is still durably recorded (in its per-fire background thread)");
  const sourceItems = await built.sessions.getItems(source!.id);
  assert.ok(
    sourceItems.some((item) => item.kind === "AgentMessage" && item.variant === null),
    "source run keeps its assistant output for audit/origin",
  );
  assert.equal(
    (await built.app.listSessions({ actorId: "U1" })).some((s) => s.id === source!.id),
    false,
    "background cron source run is not a normal participant chat",
  );
});

test("a cron-delivered digest lands as a delivery event with origin, not recipient transcript history", async () => {
  const built = freshApp();
  await built.app.upsertDirectory([
    { principalId: "U-carol", displayName: "Carol", type: "internal" },
    { principalId: "U-alice", displayName: "Alice", type: "internal" },
  ]);
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() },
    action: "deploy digest ready",
    owner: "U-carol",
    createdBy: "U-carol",
    ownerScopeId: scopeId("personal", "U-carol"),
    destination: {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    },
  });

  await runNowSettled(built.scheduler, cron.id);
  const pending = await built.deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.text, /deploy digest ready/);
  assert.match(pending[0]!.provenance?.fireKey ?? "", new RegExp(`^cron:${cron.id}:manual:`));

  await built.app.recordPrincipalDelivery(pending[0]!.id, "dm:D-alice");
  const recipient = await built.sessions.getByThread("dm:D-alice");
  assert.ok(recipient, "recipient DM session exists after delivery ack");
  assert.equal(
    (await built.sessions.getItems(recipient!.id)).some(
      (item) => item.kind === "AgentMessage" && item.variant === null,
    ),
    false,
    "recipient transcript is not polluted with a fake assistant row",
  );
  const events = await built.deliveries.listByRecipientThread("dm:D-alice");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.id, pending[0]!.id);
  assert.equal(events[0]!.provenance?.sourceSessionId, pending[0]!.provenance?.sourceSessionId);

  const visibleToSender = await built.app.listSessions({ actorId: "U-carol" });
  assert.equal(
    visibleToSender.some((s) => s.threadRef === events[0]!.provenance?.sourceThreadRef),
    false,
    "cron source session does not show as a human conversation for the sender",
  );

  await built.app.turn({
    surface: "test",
    actor: { externalId: "U-alice" },
    conversation: { kind: "dm", threadRef: "dm:D-alice" },
    text: "what was that digest?",
  });
  const reqs = await built.sessions.listLlmRequests(recipient!.id);
  const latest = reqs.at(-1) as any;
  const footer = latest.promptEnvelope.messages.at(-1).content;
  assert.match(footer, /Delivered here since the user's last message/);
  assert.match(footer, /\[cron\] from U-carol: /);
  assert.match(footer, /…$/m);
  assert.doesNotMatch(footer, /deploy digest ready/);
});

async function turnPastRetryDelay(
  t: TestContext,
  app: ReturnType<typeof freshApp>["app"],
  runs: ReturnType<typeof freshApp>["runs"],
  req: TurnRequest,
) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const result = app.turn(req);
  await settle(async () => (await runs.activeForThread(req.conversation.threadRef))?.errorAttempts === 1);
  t.mock.timers.tick(61_000);
  return result;
}

test("a retried run RESUMES the interrupted turn from the durable ledger instead of restarting it", async (t) => {
  const { app, runs } = freshApp();
  const req = dm("!work-then-boom", { idempotencyKey: "resume-1" });

  const res = await turnPastRetryDelay(t, app, runs, req);
  assert.equal(res.status, "ok");
  assert.equal(res.sourceUserSeq, 0, "provenance points at the original interrupted user entry");
  assert.equal(res.sourceAssistantEntrySeq, 3);

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "ToolCall", "ToolResult", "AgentMessage"],
    "the retry continues after the recorded work without a new user entry",
  );
});

test("a retry of an attempt that recorded NO work continues from the recorded request without re-sending it", async (t) => {
  const { app, runs } = freshApp();
  const req = dm("!boom", { idempotencyKey: "rerun-1" });

  const res = await turnPastRetryDelay(t, app, runs, req);
  assert.equal(res.status, "ok");
  assert.equal(res.sourceUserSeq, 0, "provenance points at the original user entry");

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
    "the human's request is recorded once and nothing else is added",
  );
  assert.notEqual(isHidden(found!.items[0]!), true, "the original stays visible");
});
