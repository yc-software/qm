import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../../src/cron/scheduler.ts";
import { runNowSettled } from "../support/settle.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresDirectoryStore } from "../../src/directory/postgres-directory-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { manualFireJobs } from "../support/cron-slots.ts";
import { automationOrigin } from "../support/turn-origin.ts";
import { harness, schedulerDeps } from "../support/cron-scheduler-harness.ts";

test("scheduler threads stored unattended grants into owner-mode turns", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "scan transcripts",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    unattendedGrants: ["admin.sessions.read"],
  });
  await runNowSettled(scheduler, cron.id);
  assert.deepEqual(calls[0]?.unattendedGrants, ["admin.sessions.read"]);
});

test("a channel cron runs in the channel scope and delivers its real output to the channel", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    title: "Daily standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls[0]?.conversation.kind, "channel");
  assert.equal(calls[0]?.conversation.channelRef, "C1");
  const pending = await outbound.pending("slack");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
  assert.equal(pending[0]?.provenance?.sourceTitle, "Daily standup");
});

test("a group-DM cron runs in the group scope and delivers its real output to the group", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("group", "G1"),
    destination: { type: "group", target: "G1", audienceScopeId: scopeId("group", "G1") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls[0]?.conversation.kind, "group");
  assert.equal(calls[0]?.conversation.channelRef, "G1");
  const pending = await outbound.pending("group");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a channel cron fire gives the agent the people-here roster with real <@…> mention ids", async () => {
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([
    { principalId: "eve@acme.com", displayName: "Eve", type: "internal", slackId: "U9" },
    { principalId: "U5", displayName: "Dana", type: "internal" },
  ]);
  await directory.replaceChannels(
    [{ channelId: "C1", name: "general", isPrivate: false }],
    [
      { channelId: "C1", principalId: "eve@acme.com" },
      { channelId: "C1", principalId: "U5" },
    ],
  );
  const { crons, calls, scheduler } = harness("done", directory);
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "remind Eve to confirm",
    owner: "eve@acme.com",
    createdBy: "eve@acme.com",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await runNowSettled(scheduler, cron.id);
  const text = calls[0]?.text ?? "";
  assert.match(text, /People here: [^\n]*@Eve \(<@U9>\)/);
  assert.match(text, /People here: [^\n]*@Dana \(<@U5>\)/);
  assert.match(text, /@-mention them with their <@…> id/);
  assert.doesNotMatch(text, /<@eve@acme\.com>/);
});

test("a DM cron fire carries no mention roster (DMs already notify their owner)", async () => {
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([{ principalId: "U1", displayName: "Ann", type: "internal", slackId: "U1" }]);
  const { crons, calls, scheduler } = harness("done", directory);
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "nudge me",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.doesNotMatch(calls[0]?.text ?? "", /People here:/);
});

test("a personal cron runs as a DM and delivers to the owner", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "drink water",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls[0]?.conversation.kind, "dm");
  assert.equal((await outbound.pending("slack"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("output composed at one scope delivers verbatim to a channel the owner may post to (person-keyed parity, §10)", async () => {
  const { crons, outbound, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "private digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "C9", audienceScopeId: scopeId("channel", "C9") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal((await outbound.pending("slack"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a personal cron with a principal destination delivers its real output to the teammate", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "let Alice know the deploy is done",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U1",
    },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls[0]?.conversation.kind, "dm");
  assert.deepEqual(automationOrigin(calls[0])?.destination, {
    type: "principal",
    target: "U-alice",
    audienceScopeId: scopeId("personal", "U-alice"),
    onBehalfOf: "U1",
  });
  const pending = await outbound.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a cron with a literal message delivers it verbatim, without running a turn", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { firstFireAt: 1 },
    message: "standup moved to 4pm",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U1",
    },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 0, "a literal message must not re-run a turn (that's the immediate-send confusion)");
  assert.equal((await outbound.pending("principal"))[0]?.text, "standup moved to 4pm");
});

test("a destination-less cron runs its action but delivers nothing", async () => {
  const { crons, outbound, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "nightly cleanup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 1);
  assert.equal((await outbound.pending("slack")).length, 0);
});

test("a one-shot cron is auto-disabled after it fires", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { firstFireAt: 1 },
    action: "remind me once",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 1);
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("a conversation-owned cron keeps running as the conversation, whoever created it", async () => {
  const { crons, calls, scheduler, identity } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "system:channel:C1",
    createdBy: "system:channel:C1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await identity.deactivate("U1");
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls[0]?.actor.externalId, "system:channel:C1");
  assert.equal((await crons.get(cron.id))?.enabled, true);
});

test("a person-owned cron is deleted once its owner has left the conversation", async () => {
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  await directory.replace([
    { principalId: "U1", displayName: "Ann", type: "internal" },
    { principalId: "U2", displayName: "Bo", type: "internal" },
  ]);
  await directory.replaceChannels(
    [{ channelId: "C1", name: "eng", isPrivate: true }],
    [{ channelId: "C1", principalId: "U2" }],
  );
  const { crons, calls, scheduler } = harness("done", directory);
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "my digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 0);
  assert.equal(await crons.get(cron.id), null);
});

test("an owner cron still disables when its owner leaves (unchanged)", async () => {
  const { crons, calls, scheduler, identity } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "my digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await identity.deactivate("U1");
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 0);
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("a failing interval cron does not starve later due crons across ticks", async () => {
  const { crons, calls, scheduler } = harness(async (req) => {
    if (req.text.includes("fail first")) throw new Error("cron failed");
    return { status: "ok", reply: "OUT" };
  });
  const failing = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "fail first",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  const succeeding = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "succeed second",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });

  await scheduler.tick(2000);
  await scheduler.tick(3500);

  assert.deepEqual(
    calls.map((call) => call.idempotencyKey),
    [`cron:${failing.id}:1`, `cron:${succeeding.id}:1`, `cron:${failing.id}:1`, `cron:${succeeding.id}:3000`],
  );
});

test("runNow fires even when the current schedule slot already did (manual re-run)", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await scheduler.tick(2000);
  assert.equal(calls.length, 1);
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 2, "a manual run must not be swallowed by the already-fired slot");
});

test("runNow does not shift the schedule (lastFiredAt untouched, next tick still fires)", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal((await crons.get(cron.id))?.lastFiredAt, undefined, "a manual run must not stamp the schedule");
  await scheduler.tick(2000);
  assert.equal(calls.length, 2, "the scheduled fire still happens after a manual run");
  assert.equal((await crons.get(cron.id))?.lastFiredAt, 2000);
});

test("a re-enabled one-shot cron can be re-run manually", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { firstFireAt: 1 },
    action: "remind me once",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal((await crons.get(cron.id))?.enabled, false);
  await crons.update(cron.id, { enabled: true });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 2, "re-enabling a one-shot lets it be re-run manually");
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("a cron turn carries its fire key as the run idempotency key (atomic DB-level dedupe)", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await scheduler.tick(2000);
  assert.equal(calls[0]?.idempotencyKey, `cron:${cron.id}:1`);
  await runNowSettled(scheduler, cron.id);
  assert.match(calls[1]?.idempotencyKey ?? "", new RegExp(`^cron:${cron.id}:manual:`));
});

test("a cron fires into fresh per-fire threads while keeping per-fire idempotency keys", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "daily check-in",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await scheduler.tick(2000);
  await scheduler.tick(3500);
  await runNowSettled(scheduler, cron.id);

  assert.equal(calls.length, 3);
  const threads = calls.map((c) => c.conversation.threadRef);
  assert.equal(new Set(threads).size, 3, "each fire gets a fresh internal thread");
  assert.ok(threads.every((thread) => thread?.startsWith(`cron:${cron.id}:fire:`)));
  assert.equal(calls[0]?.idempotencyKey, `cron:${cron.id}:1`);
  assert.equal(calls[1]?.idempotencyKey, `cron:${cron.id}:3000`);
  assert.match(calls[2]?.idempotencyKey ?? "", new RegExp(`^cron:${cron.id}:manual:`));
  assert.notEqual(calls[1]?.conversation.threadRef, calls[1]?.idempotencyKey);
});

test("cron fires do not replay prior sessions or inline prior fire context", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const sessions = createPostgresSessionStore(databaseUrl);
  const scope = scopeId("personal", "U1");
  const sessionIds: string[] = [];
  const priorAssistantSeen: number[] = [];
  const texts: string[] = [];
  const replies = ['first <invoke name="execute">', "second ok"];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    const session = await sessions.getOrCreateByThread(req.conversation.threadRef!, "dm", scope);
    sessionIds.push(session.id);
    priorAssistantSeen.push((await sessions.getItems(session.id)).filter((i) => i.kind === "AgentMessage").length);
    texts.push(req.text);
    const { lease } = await sessions.acquireLease(session.id);
    assert.ok(lease, "fires are serial, so the lease is always free");
    await sessions.append(lease, { kind: "UserMessage", text: req.text });
    await sessions.append(lease, { kind: "AgentMessage", text: replies[sessionIds.length - 1] ?? "ok" });
    await sessions.releaseLease(lease);
    return { status: "ok", reply: replies[sessionIds.length - 1] ?? "ok", sessionId: session.id };
  };
  const scheduler = createScheduler({
    jobs: manualFireJobs(),
    ...schedulerDeps(crons, databaseUrl),
    run,
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "daily check-in",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scope,
  });
  await scheduler.tick(2000);
  await scheduler.tick(3500);

  assert.equal(sessionIds.length, 2);
  assert.notEqual(sessionIds[0], sessionIds[1], "each fire resolves to a fresh session");
  assert.deepEqual(priorAssistantSeen, [0, 0], "fire 2 does not replay fire 1's assistant entry");
  assert.match(texts[1] ?? "", /no memory of previous fires/);
  assert.match(texts[1] ?? "", /action="runs"/);
  assert.match(texts[1] ?? "", /Files via the available Files API/);
  assert.match(texts[1] ?? "", /GET \/v1\/files\/:id\/content/);
  assert.match(texts[1] ?? "", /confirm publication succeeds/);
  assert.match(texts[1] ?? "", /If publication is unavailable/);
  assert.doesNotMatch(texts[1] ?? "", /Your workspace disk/);
  assert.doesNotMatch(texts[1] ?? "", /Recent fires/);
  assert.doesNotMatch(texts[1] ?? "", /first <invoke name="execute">/);
  assert.doesNotMatch(texts[1] ?? "", /first \[invoke name="execute"\]/);
  const { runs: stored } = await crons.listFires(cron.id);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.reply, 'first <invoke name="execute">');
});

test("an idempotency-skipped cron fire does not create fire log history", async () => {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const calls: TurnRequest[] = [];
  const scheduler = createScheduler({
    jobs: manualFireJobs(),
    ...singleProcessDeps(),
    crons,
    outbound: recordingOutbound(),
    idempotency: {
      once: async () => false,
      committed: async () => true,
    },
    identity: createIdentityService(databaseUrl),
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "OUT" };
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "daily check-in",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });

  await scheduler.tick(2500);

  const after = await crons.get(cron.id);
  assert.equal(calls.length, 0, "duplicate slot does not reach the agent");
  assert.equal((await crons.listFires(cron.id)).total, 0, "duplicate slot does not look like a fire");
  assert.equal(after?.lastFiredAt, 2500, "the due slot is still advanced after durable dedupe");
});

test("cron fire log omits replies that echo the runtime wrapper", async () => {
  const { crons, calls, scheduler } = harness(async (req) => ({ status: "ok", reply: `You said: ${req.text}` }));
  await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "daily check-in",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });

  await scheduler.tick(2000);
  await scheduler.tick(3500);

  const { runs: stored } = await crons.listFires((await crons.list())[0]!.id);
  assert.equal(stored[0]?.reply, "[reply echoed cron runtime context; omitted]");
  assert.doesNotMatch(calls[1]?.text ?? "", /reply=You said: \[Cron runtime context\]/);
  assert.doesNotMatch(calls[1]?.text ?? "", /reply=\[reply echoed cron runtime context; omitted\]/);
});

test("a calendar cron uses the scheduled instant for a missed tick idempotency key", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-06-18T15:58:00.000Z"));
  const { crons, calls, scheduler } = harness();
  const scheduledAt = Date.parse("2026-06-18T16:00:00.000Z");
  const firedAt = Date.parse("2026-06-18T16:05:00.000Z");
  const cron = await crons.create({
    schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await scheduler.tick(firedAt);
  assert.equal(calls[0]?.idempotencyKey, `cron:${cron.id}:${scheduledAt}`);
  const stored = await crons.get(cron.id);
  assert.equal(stored?.lastFiredAt, firedAt);
  assert.equal(stored?.nextFireAt, Date.parse("2026-06-19T16:00:00.000Z"));
});

test("a failing cron fire is logged, not swallowed", async (t) => {
  const databaseUrl = testDatabaseUrl();
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const scheduler = createScheduler({
    jobs: manualFireJobs(),
    ...schedulerDeps(crons, databaseUrl),
    run: async () => {
      throw new Error("boom");
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  await scheduler.tick();
  assert.ok(
    logged.some((l) => l.includes("[failed] scheduler: fire:") && l.includes("boom")),
    "the fire error must reach the log",
  );
  const { runs: after } = await crons.listFires(cron.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.status, "failed");
  assert.equal(after[0]?.note, "boom");
});
