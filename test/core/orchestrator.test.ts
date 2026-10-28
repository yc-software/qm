import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutboundPost } from "../../src/surfaces/outbound.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "../support/test-config.ts";
import { runNowSettled } from "../support/settle.ts";
import type { ProvisionOptions } from "../../src/sandbox/sandbox.ts";
import { verifyCapabilityToken } from "../../src/auth/capability-token.ts";
import { isReply, isUserMessage } from "../../src/sessions/items.ts";
import { buildTestApp, channel, dm, failedTurn, freshApp, internalActor } from "../support/orchestrator-app.ts";
import { mockPrompts } from "../support/mock-harness/turn.ts";

test("internal DM turn runs end-to-end and records the session", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("hello there"));
  assert.equal(res.status, "ok");
  assert.ok(res.sessionId);
  assert.match(res.reply ?? "", /You said: hello there/);

  const found = await app.getSession(res.sessionId!);
  const types = found!.items.map((e) => e.kind);
  assert.deepEqual(types, ["UserMessage", "AgentMessage"]);
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
    const payload = found!.items.filter((entry) => isUserMessage(entry)).at(-1)!.body as {
      speakerId?: string;
      name?: string;
    };
    assert.equal(payload.speakerId, actor.externalId);
    assert.equal(payload.name, actor.displayName);
  }
});

test("the persisted assistant entry carries authoritative turn timing for transcript rendering", async () => {
  const { app } = freshApp();
  const before = Date.now();
  const res = await app.turn(dm("hello timing"));
  assert.equal(res.status, "ok");
  const found = await app.getSession(res.sessionId!);
  const assistant = found!.items.find((e) => isReply(e));
  const p = assistant!.body as { workStartedAt?: number; workFinishedAt?: number };
  assert.equal(typeof p.workStartedAt, "number", "turn start is persisted");
  assert.equal(typeof p.workFinishedAt, "number", "turn finish is persisted");
  assert.ok(p.workStartedAt! >= before && p.workFinishedAt! >= p.workStartedAt!);
});

test("the deployment turn wall-clock reaches the harness and a per-turn cap replaces it", async (t) => {
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

  const entries = await sessions.getItems(res.sessionId!);
  assert.equal(
    entries.some(
      (e) =>
        ["ContextCompaction", "Error", "Stop", "Retraction", "Wake"].includes(e.kind) &&
        /screenshot\.png/.test(JSON.stringify(e)),
    ),
    false,
  );
  const user = entries.find((e) => isUserMessage(e));
  assert.match(
    String((user!.body as { environment?: unknown }).environment),
    /<environment>[\s\S]*did not reach \.\/inbox\/[\s\S]*screenshot\.png[\s\S]*<\/environment>/,
  );

  assert.ok(
    mockPrompts(res.sessionId!).some((prompt) => /screenshot\.png/.test(JSON.stringify(prompt))),
    "the model sees the dropped file",
  );

  assert.equal((res as { fileNotes?: unknown }).fileNotes, undefined);
});

test("a failed turn still records which inbound files did not arrive", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { sessions, errors } = built;
  const note = 'skipped "screenshot.png" — too many files in one message (max 10)';
  await failedTurn(built, dm("!boom", { inboundNotes: [note] }), /boom/);
  const { sessionId } = (await errors.list()).find((e) => e.category === "turn")!;
  const user = (await sessions.getItems(sessionId!)).find((e) => isUserMessage(e));
  assert.match(String((user?.body as { environment?: unknown } | undefined)?.environment), /screenshot\.png/);
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
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.equal(userEntry.hidden, true, "the opener seed is hidden so no surface renders it");
});

test("a proactiveOpener turn that carries real text keeps the user entry visible", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("actually, here's my real question", { proactiveOpener: true }));
  assert.equal(res.status, "ok", res.reason);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.notEqual(userEntry.hidden, true, "a real typed message stays visible even on an opener-flagged turn");
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
  const userEntry = found!.items.find((e) => isUserMessage(e))!;
  assert.equal(userEntry.hidden, true, "the wake prompt is hidden so no surface renders it as a user message");
});

test("a 1:1 names the authenticated human in the prompt so the agent never asks who they are", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("hi", { actor: { externalId: "ada@acme.com", displayName: "Ada Lovelace" } }));
  assert.equal(res.status, "ok", res.reason);
  assert.match(mockPrompts(res.sessionId!).at(-1)!.system, /live private 1:1 with Ada Lovelace \(ada@acme\.com\)/);
});

test("a channel turn gets no 1:1 identity block", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("hi", { actor: { externalId: "U1", displayName: "Ada" } }));
  assert.equal(res.status, "ok", res.reason);
  assert.doesNotMatch(mockPrompts(res.sessionId!).at(-1)!.system, /## Who you're talking to/);
});

test("a silent cron source run stays out of normal human chat history", async () => {
  const built = freshApp();
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() + 3_600_000 },
    action: "!preamble-then-quiet Posted the digest DM",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "principal", target: "U2", audienceScopeId: scopeId("personal", "U2"), onBehalfOf: "U1" },
  });

  await runNowSettled(built.scheduler, cron.id);

  assert.equal((await built.posts.pending("principal")).length, 0, "finish_silently means no delivery");
  const source = (await built.sessions.listByScope(scopeId("personal", "U1"))).find((s) =>
    s.threadRef.startsWith(`cron:${cron.id}:fire:`),
  );
  assert.ok(source, "cron source run is still durably recorded (in its per-fire background thread)");
  const sourceEntries = await built.sessions.getItems(source!.id);
  assert.ok(
    sourceEntries.some((e) => isReply(e)),
    "source run keeps its assistant output for audit/origin",
  );
  assert.equal(
    (await built.app.listSessions("U1")).some((s) => s.id === source!.id),
    false,
    "background cron source run is not a normal participant chat",
  );
});

test("a cron-delivered digest is noted in the recipient's next DM turn, not written into their transcript", async () => {
  const built = freshApp();
  const posted: OutboundPost[] = [];
  built.outbound.register(["principal"], async (post) => {
    posted.push(post);
    return { recipientThreadRef: "dm:D-alice" };
  });
  await built.app.upsertDirectory([
    { principalId: "U-carol", displayName: "Carol", type: "internal" },
    { principalId: "U-alice", displayName: "Alice", type: "internal" },
  ]);
  const cron = await built.app.createCron({
    schedule: { firstFireAt: Date.now() + 3_600_000 },
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
  const pending = posted;
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.text, /deploy digest ready/);
  assert.match(pending[0]!.provenance?.fireKey ?? "", new RegExp(`^cron:${cron.id}:manual:`));

  let recipient = await built.sessions.getByThread("dm:D-alice");
  for (let i = 0; i < 50 && !recipient; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    recipient = await built.sessions.getByThread("dm:D-alice");
  }
  assert.ok(recipient, "recipient DM session exists once the post lands");
  assert.equal(
    (await built.sessions.getItems(recipient!.id)).some((e) => isReply(e)),
    false,
    "recipient transcript is not polluted with a fake assistant row",
  );

  const visibleToSender = await built.app.listSessions("U-carol");
  assert.equal(
    visibleToSender.some((s) => s.threadRef === pending[0]!.provenance?.sourceThreadRef),
    false,
    "cron source session does not show as a human conversation for the sender",
  );

  await built.app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor: { externalId: "U-alice" },
    conversation: { kind: "dm", threadRef: "dm:D-alice" },
    text: "what was that digest?",
  });
  const footer = mockPrompts(recipient!.id).at(-1)!.messages.at(-1)!.content;
  assert.match(footer, /Delivered here since the user's last message/);
  assert.match(footer, /\[cron\] from U-carol:/);
  assert.ok(footer.includes(pending[0]!.text.trim().split("\n")[0]!), "the delivered text is quoted in full");
});

test("a turn whose setup fails is retried before the next turn in the conversation runs", async () => {
  const built = freshApp();
  const { app, keychain } = built;
  assert.ok(keychain);

  const realGrantsForScope = keychain.grantsForScope.bind(keychain);
  const attempted: string[] = [];
  const claim = built.turnLedger.claim.bind(built.turnLedger);
  built.turnLedger.claim = async (...args) => {
    const claimed = await claim(...args);
    if (claimed.run) attempted.push(claimed.run.request.text);
    return claimed;
  };
  let injectFailure = true;
  keychain.grantsForScope = async (...args: Parameters<typeof realGrantsForScope>) => {
    if (injectFailure) {
      injectFailure = false;
      throw new Error("injected setup failure");
    }
    return realGrantsForScope(...args);
  };

  const first = await app.turn(dm("hi"));
  assert.equal(first.status, "ok", first.reason);

  const res = await app.turn(dm("hi again"));
  assert.equal(res.status, "ok", res.reason);
  assert.doesNotMatch(res.reason ?? "", /session busy/);
  assert.deepEqual(attempted, ["hi", "hi", "hi again"]);
});

test("a retried run RESUMES the interrupted turn from the durable ledger instead of restarting it", async () => {
  const { app } = freshApp();
  const req = dm("!work-then-boom", { idempotencyKey: "resume-1" });

  const res = await app.turn(req);
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

test("a retry of an attempt that recorded NO work continues from the recorded request without re-sending it", async () => {
  const { app } = freshApp();
  const req = dm("!boom", { idempotencyKey: "rerun-1" });

  const res = await app.turn(req);
  assert.equal(res.status, "ok");
  assert.equal(res.sourceUserSeq, 0, "provenance points at the original user entry");

  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
    "the human's request is recorded once and nothing else is added",
  );
  assert.notEqual(found!.items[0]!.hidden, true, "the original stays visible");
});

test("a guest actor is refused (internal-only, input side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor: { externalId: "G1", isExternalGuest: true },
    conversation: { kind: "dm", threadRef: "dm:G1:t1" },
    text: "hi",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("a channel with a non-internal audience member is refused (internal-only, output side)", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "C1:t1",
      channelRef: "C1",
      audience: [internalActor, { externalId: "G9", isExternalGuest: true }],
    },
    text: "hello channel",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.refusalKind, "internal_only");
  assert.match(res.reason ?? "", /internal-only/);
});

test("identity grounding: the roster lists this conversation's participants by their canonical directory name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Alice Example", type: "internal" },
    { principalId: "U2", displayName: "Renee Mars", type: "internal" },
    { principalId: "U3", displayName: "taylor", type: "internal" },
    { principalId: "U9", displayName: "Outsider Olive", type: "internal" },
  ]);
  const prompt = await app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster:t1",
      channelRef: "C-roster",
      audience: [internalActor, { externalId: "U2" }, { externalId: "U3" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /## Who's in this conversation/);
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Renee Mars \(U2\)/);
  assert.match(sp, /taylor \(U3\)/);
  assert.doesNotMatch(sp, /Outsider Olive/);
});

test("identity grounding: the roster names every member when the room fits the context budget", async () => {
  const { app, directory } = freshApp();
  const many = Array.from({ length: 30 }, (_, i) => ({
    principalId: `U${i}`,
    displayName: `Person ${i}`,
    type: "internal" as const,
  }));
  await directory.replace(many);
  const prompt = await app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: { externalId: "U0" },
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-big:t1",
      channelRef: "C-roster-big",
      audience: many.map((m) => ({ externalId: m.principalId })),
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  const listed = (sp.match(/- Person \d+ \(U\d+\)/g) ?? []).length;
  assert.equal(listed, 30, "thirty short lines fit the inventory budget");
  assert.doesNotMatch(sp, /more in this conversation\./);
});

test("identity grounding: a participant who hasn't synced into the directory still grounds from the surface name", async () => {
  const { app, directory } = freshApp();
  await directory.replace([{ principalId: "U1", displayName: "Alice Example", type: "internal" }]);
  const prompt = await app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-partial:t1",
      channelRef: "C-roster-partial",
      audience: [internalActor, { externalId: "U7", displayName: "Newcomer Nat" }],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(sp, /Alice Example \(U1\)/);
  assert.match(sp, /Newcomer Nat \(U7\)/);
});

test("identity grounding: a cased-vs-lowercase duplicate participant resolves to the single real directory member", async () => {
  const { app, directory } = freshApp();
  await directory.replace([
    { principalId: "U1", displayName: "Jordan Lee", type: "internal" },
    { principalId: "alice@acme.com", displayName: "Alice Wonderland", type: "internal" },
  ]);
  const prompt = await app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: "ch:roster-case:t1",
      channelRef: "C-roster-case",
      audience: [
        internalActor,
        { externalId: "Alice@acme.com", displayName: "Cased Alias" },
        { externalId: "alice@acme.com" },
      ],
    },
    text: "!sysprompt",
  });
  const sp = prompt.reply ?? "";
  assert.match(
    sp,
    /Alice Wonderland \(alice@acme\.com\)/,
    "the cased participant grounds as the canonical directory member",
  );
  assert.doesNotMatch(sp, /Cased Alias/, "no synthetic fallback entry when the person is in the directory");
  assert.equal((sp.match(/Alice/g) ?? []).length, 1, "the duplicate is listed exactly once");
});

test("an org admin's live turn carries the admin prompt hint and a liveness claim; a regular user's does not", async () => {
  const config = testConfig({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  const { app, sandbox } = buildTestApp(config);
  let captured: ProvisionOptions | undefined;
  const realProvision = sandbox.provision.bind(sandbox);
  sandbox.provision = (layers, opts) => {
    captured = opts;
    return realProvision(layers, opts);
  };

  const adminTurn = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
    surface: "test",
    actor: { externalId: "admin-alice" },
    conversation: { kind: "dm", threadRef: "dm:admin-alice:t1" },
    text: "!run echo hi",
    origin: { kind: "human" },
    ...extra,
  });

  assert.equal((await app.turn(adminTurn())).status, "ok");
  const adminClaims = await verifyCapabilityToken(captured!.env!.AGENT_API_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(adminClaims!.liveActor, true, "a human-initiated turn attests liveness in the token");

  const adminPrompt = await app.turn(
    adminTurn({ text: "!sysprompt", conversation: { kind: "dm", threadRef: "dm:admin-alice:t2" } }),
  );
  assert.match(adminPrompt.reply ?? "", /## Acting for an org admin/);
  assert.match(adminPrompt.reply ?? "", /use the hand-off skill even if admin access could reach it/);
  assert.match(adminPrompt.reply ?? "", /System administration is not limited to the admin dashboard/);
  assert.match(adminPrompt.reply ?? "", /including resources owned by other users/);
  assert.match(adminPrompt.reply ?? "", /Ordinary resource-owner restrictions do not by themselves prohibit/);
  assert.match(adminPrompt.reply ?? "", /admin grant changes and impersonation are portal-only/);
  assert.match(adminPrompt.reply ?? "", /private-content reads require a DM or a turn the admin started/);
  assert.doesNotMatch(
    adminPrompt.reply ?? "",
    /private-content reads work only from a DM|bulk configuration imports require/,
  );

  const userPrompt = await app.turn(dm("!sysprompt"));
  assert.doesNotMatch(userPrompt.reply ?? "", /## Acting for an org admin|System administration is not limited/);
});
