import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import { isPollSurface, isSilentPollReply } from "../src/triggers/run-trigger.ts";
import { createDirectoryStore, type DirectoryStore } from "../src/directory/directory-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Cron } from "../src/types.ts";

function fakeLease(isLeader: () => boolean): LeaderLease {
  return {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return isLeader() ? fn(new Promise<void>(() => {})) : null;
    },
  };
}

function harness(
  reply: string | ((req: TurnRequest) => Promise<TurnResult>) = "CRON-OUTPUT-XYZ",
  directory?: DirectoryStore,
  maxFiresPerTick?: number,
) {
  const crons = createCronStore();
  const deliveries = createDeliveryStore();
  const identity = createIdentityService();
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (typeof reply === "function") return reply(req);
    if (req.triggered && req.surface && isPollSurface(req.surface) && isSilentPollReply(reply)) {
      return { status: "silent" };
    }
    return { status: "ok", reply };
  };
  const scheduler = createScheduler({
    crons,
    deliveries,
    idempotency: createIdempotencyStore(),
    identity,
    run,
    ...(directory ? { directory } : {}),
    ...(maxFiresPerTick !== undefined ? { maxFiresPerTick } : {}),
  });
  return { crons, deliveries, calls, scheduler, identity };
}

const member = (id: string) => ({ id, type: "internal" as const });

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
  await scheduler.runNow(cron.id);
  assert.deepEqual(calls[0]?.unattendedGrants, ["admin.sessions.read"]);
});

test("a channel cron runs in the channel scope and delivers its real output to the channel", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls[0]?.conversation.kind, "channel");
  assert.equal(calls[0]?.conversation.channelRef, "C1");
  const pending = await deliveries.pending("slack");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a group-DM cron runs in the group scope and delivers its real output to the group", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("group", "G1"),
    destination: { type: "group", target: "G1", audienceScopeId: scopeId("group", "G1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls[0]?.conversation.kind, "group");
  assert.equal(calls[0]?.conversation.channelRef, "G1");
  const pending = await deliveries.pending("group");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a group-DM relay message delivers verbatim, floored to the group", async () => {
  const { crons, deliveries, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    message: "standup in 5 🚀",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("group", "G1"),
    destination: { type: "group", target: "G1", audienceScopeId: scopeId("group", "G1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal((await deliveries.pending("group"))[0]?.text, "standup in 5 🚀");
});

test("a group-DM cron composed at another scope delivers verbatim (person-keyed parity, §10)", async () => {
  const { crons, deliveries, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "private digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "group", target: "G1", audienceScopeId: scopeId("group", "G1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal((await deliveries.pending("group"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a poll cron whose turn replies [no-update] runs but delivers nothing", async () => {
  const { crons, deliveries, calls, scheduler } = harness("  [no-update]\n");
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "check the status page; reply [no-update] if unchanged",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 1);
  assert.equal((await deliveries.pending("slack")).length, 0);
});

test("a poll cron stays silent on an empty reply or a bare silence token", async (t) => {
  const cases = [
    ["empty reply — the natural nothing-to-report", ""],
    ["whitespace-only reply", "  \n\n "],
    ["summary then canonical marker", "No unread mail in the last hour.\n\n[no-update]"],
    ["upper no reply marker", "Nothing changed.\nNO_REPLY"],
    ["lower no reply marker", "Nothing changed.\nno_reply"],
    ["silent marker", "All quiet.\n[SILENT]\n\n"],
    ["case-insensitive canonical marker", "No changes.\n[NO-UPDATE]"],
  ] as const;
  for (const [name, reply] of cases) {
    await t.test(name, async () => {
      const { crons, deliveries, calls, scheduler } = harness(reply);
      const cron = await crons.create({
        schedule: { everyMs: 1000 },
        action: "check the mailbox; output [no-update] if unchanged",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
        destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
      });
      await scheduler.runNow(cron.id);
      assert.equal(calls.length, 1);
      assert.equal((await deliveries.pending("slack")).length, 0);
    });
  }
});

test("a channel cron fire gives the agent the people-here roster with real <@…> mention ids", async () => {
  const directory = createDirectoryStore();
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
    runAs: "scopeShared",
    members: [member("eve@acme.com"), member("U5")],
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await scheduler.runNow(cron.id);
  const text = calls[0]?.text ?? "";
  assert.match(text, /People here: @Eve \(<@U9>\), @Dana \(<@U5>\)\./);
  assert.match(text, /@-mention them with their <@…> id/);
  assert.doesNotMatch(text, /<@eve@acme\.com>/);
});

test("a DM cron fire carries no mention roster (DMs already notify their owner)", async () => {
  const directory = createDirectoryStore();
  await directory.replace([{ principalId: "U1", displayName: "Ann", type: "internal", slackId: "U1" }]);
  const { crons, calls, scheduler } = harness("done", directory);
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "nudge me",
    owner: "U1",
    createdBy: "U1",
    members: [member("U1")],
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await scheduler.runNow(cron.id);
  assert.doesNotMatch(calls[0]?.text ?? "", /People here:/);
});

test("a poll cron delivers when a silent marker is not the final non-empty line", async () => {
  const { crons, deliveries, scheduler } = harness("[no-update]\nFound one failed check");
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "check the status page",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal((await deliveries.pending("slack"))[0]?.text, "[no-update]\nFound one failed check");
});

test("a personal cron runs as a DM and delivers to the owner", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "drink water",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls[0]?.conversation.kind, "dm");
  assert.equal((await deliveries.pending("slack"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("output composed at one scope delivers verbatim to a channel the owner may post to (person-keyed parity, §10)", async () => {
  const { crons, deliveries, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "private digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    destination: { type: "slack", target: "C9", audienceScopeId: scopeId("channel", "C9") },
  });
  await scheduler.runNow(cron.id);
  assert.equal((await deliveries.pending("slack"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a personal cron with a principal destination delivers its real output to the teammate", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
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
    recipientConsent: { recipientId: "U-alice", status: "accepted" },
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls[0]?.conversation.kind, "dm");
  assert.deepEqual(calls[0]?.triggerDestination, {
    type: "principal",
    target: "U-alice",
    audienceScopeId: scopeId("personal", "U-alice"),
    onBehalfOf: "U1",
  });
  const pending = await deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a recurring teammate-DM cron without current recipient consent is withheld", async () => {
  const { crons, deliveries, scheduler } = harness();
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
  await scheduler.runNow(cron.id);
  const pending = await deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.destination.target, "U1");
  assert.match(pending[0]?.text ?? "", /consent.*skipped/i);
  const stored = await crons.get(cron.id);
  assert.equal(stored?.fireLog?.[0]?.status, "refused");
  assert.match(stored?.fireLog?.[0]?.note ?? "", /consent/);
});

test("a teammate-DM cron created in a channel delivers its real output (§10 parity gate)", async () => {
  const { crons, deliveries, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "summarize this channel and DM it to Alice",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U1",
    },
    recipientConsent: { recipientId: "U-alice", status: "accepted" },
  });
  await scheduler.runNow(cron.id);
  assert.equal((await deliveries.pending("principal"))[0]?.text, "CRON-OUTPUT-XYZ");
});

test("a cron with a literal message delivers it verbatim, without running a turn", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
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
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 0, "a literal message must not re-run a turn (that's the immediate-send confusion)");
  assert.equal((await deliveries.pending("principal"))[0]?.text, "standup moved to 4pm");
});

test("a destination-less cron runs its action but delivers nothing", async () => {
  const { crons, deliveries, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "nightly cleanup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 1);
  assert.equal((await deliveries.pending("slack")).length, 0);
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
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 1);
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("only the leader instance fires due crons on tick (non-leader skips)", async () => {
  const crons = createCronStore();
  const deliveries = createDeliveryStore();
  const idempotency = createIdempotencyStore();
  const identity = createIdentityService();
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return { status: "ok", reply: "OUT" };
  };
  let leader = false;
  const scheduler = createScheduler({
    crons,
    deliveries,
    idempotency,
    identity,
    run,
    leaderLease: fakeLease(() => leader),
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });

  await scheduler.tick(2000);
  assert.equal(calls.length, 0, "a non-leader instance fires nothing");
  assert.equal((await crons.get(cron.id))?.lastFiredAt, undefined, "the cron is untouched");

  leader = true;
  await scheduler.tick(2000);
  assert.equal(calls.length, 1, "the leader fires the due cron");
});

test("a scopeFloor cron fires with the member snapshot as the turn audience (floor execution)", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    runAs: "scopeFloor",
    members: [member("U1"), member("U2"), member("U3")],
  });
  await scheduler.runNow(cron.id);
  const aud = (calls[0]?.conversation.audience ?? []).map((a) => a.externalId).sort();
  assert.deepEqual(aud, ["U1", "U2", "U3"]);
});

test("a scopeFloor cron survives the creator leaving — runs as a remaining internal member", async () => {
  const { crons, calls, scheduler, identity } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    runAs: "scopeFloor",
    members: [member("U1"), member("U2")],
  });
  await identity.deactivate("U1");
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.actor.externalId, "U2");
  assert.equal((await crons.get(cron.id))?.enabled, true);
});

test("a scopeFloor cron with no internal members left fails closed (disabled, nothing runs)", async () => {
  const { crons, calls, scheduler, identity } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    runAs: "scopeFloor",
    members: [member("U1")],
  });
  await identity.deactivate("U1");
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 0);
  assert.equal((await crons.get(cron.id))?.enabled, false);
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
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 0);
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("the default (no-op) lease ticks exactly as before — memory-mode behavior is unchanged", async () => {
  const { crons, calls, scheduler } = harness();
  await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await scheduler.tick(2000);
  assert.equal(calls.length, 1, "without a lease, the tick fires due crons as before");
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

test("a capped batch of persistent failures rotates — later due crons still get their turn", async () => {
  const { crons, calls, scheduler } = harness(
    async (req) => {
      if (req.text.includes("always fails")) throw new Error("cron failed");
      return { status: "ok", reply: "OUT" };
    },
    undefined,
    2,
  );
  for (let i = 0; i < 3; i++) {
    await crons.create({
      schedule: { everyMs: 60_000, firstFireAt: 1 },
      action: `always fails ${i}`,
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
    });
  }
  const healthy = await crons.create({
    schedule: { everyMs: 60_000, firstFireAt: 1 },
    action: "healthy last in line",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });

  await scheduler.tick(2000);
  await scheduler.tick(3000);

  assert.ok(
    calls.some((call) => call.idempotencyKey === `cron:${healthy.id}:1`),
    "the healthy cron behind a full batch of failures fires within two ticks",
  );
});

test("capped rotation is driven by durable attempt order, not tick arrival times", async () => {
  const { crons, calls, scheduler } = harness("OUT", undefined, 2);
  const created: Cron[] = [];
  for (let i = 0; i < 4; i++) {
    created.push(
      await crons.create({
        schedule: { everyMs: 600_000, firstFireAt: 1 },
        action: `cron ${i}`,
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      }),
    );
  }

  await scheduler.tick(2000);
  await scheduler.tick(4000);

  for (const cron of created) {
    assert.ok(
      calls.some((call) => call.idempotencyKey === `cron:${cron.id}:1`),
      "every due cron fires within ceil(due/cap) ticks even when tick timestamps skip buckets",
    );
  }
});

test("a cron whose attempt marker cannot persist is held back and cannot starve the rest", async () => {
  const backing = createMemoryMap<Cron>();
  const crons = createCronStore(backing);
  const deliveries = createDeliveryStore();
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return { status: "ok", reply: "OUT" };
  };
  const created: Cron[] = [];
  for (let i = 0; i < 5; i++) {
    created.push(
      await crons.create({
        schedule: { everyMs: 600_000, firstFireAt: 1 },
        action: `cron ${i}`,
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      }),
    );
  }
  const broken = created[0]!;
  const flaky: typeof crons = {
    ...crons,
    async markAttempted(id, at) {
      if (id === broken.id) throw new Error("attempt marker write failed");
      return crons.markAttempted(id, at);
    },
  };
  const scheduler = createScheduler({
    crons: flaky,
    deliveries,
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run,
    maxFiresPerTick: 2,
  });

  await scheduler.tick(2000);
  await scheduler.tick(4000);

  assert.ok(
    !calls.some((call) => call.idempotencyKey === `cron:${broken.id}:1`),
    "a capped batch never fires a cron whose attempt failed to persist",
  );
  for (const cron of created.slice(1)) {
    assert.ok(
      calls.some((call) => call.idempotencyKey === `cron:${cron.id}:1`),
      "the crons behind the broken marker still fire within two capped ticks",
    );
  }
});

test("capped rotation survives a scheduler restart mid-cycle", async () => {
  const backing = createMemoryMap<Cron>();
  const crons = createCronStore(backing);
  const deliveries = createDeliveryStore();
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return { status: "ok", reply: "OUT" };
  };
  const mk = () =>
    createScheduler({
      crons,
      deliveries,
      idempotency: createIdempotencyStore(),
      identity: createIdentityService(),
      run,
      maxFiresPerTick: 2,
    });
  const created: Cron[] = [];
  for (let i = 0; i < 4; i++) {
    created.push(
      await crons.create({
        schedule: { everyMs: 600_000, firstFireAt: 1 },
        action: `cron ${i}`,
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      }),
    );
  }

  await mk().tick(2000);
  await mk().tick(2000);

  for (const cron of created) {
    assert.ok(
      calls.some((call) => call.idempotencyKey === `cron:${cron.id}:1`),
      "a fresh scheduler instance resumes the rotation from durable state instead of restarting it",
    );
  }
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
  await scheduler.runNow(cron.id);
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
  await scheduler.runNow(cron.id);
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
  await scheduler.runNow(cron.id);
  assert.equal((await crons.get(cron.id))?.enabled, false);
  await crons.update(cron.id, { enabled: true });
  await scheduler.runNow(cron.id);
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
  await scheduler.runNow(cron.id);
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
  await scheduler.runNow(cron.id);

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
  const crons = createCronStore();
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "U1");
  const sessionIds: string[] = [];
  const priorAssistantSeen: number[] = [];
  const texts: string[] = [];
  const replies = ['first <invoke name="execute">', "second ok"];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    const session = await sessions.getOrCreateByThread(req.conversation.threadRef!, "dm", scope);
    sessionIds.push(session.id);
    priorAssistantSeen.push((await sessions.getEntries(session.id)).filter((e) => e.type === "assistant").length);
    texts.push(req.text);
    const { lease } = await sessions.acquireLease(session.id);
    assert.ok(lease, "fires are serial, so the lease is always free");
    await sessions.append(lease, { type: "user", payload: { text: req.text }, scopeLabel: scope });
    await sessions.append(lease, {
      type: "assistant",
      payload: { text: replies[sessionIds.length - 1] ?? "ok" },
      scopeLabel: scope,
    });
    await sessions.releaseLease(lease);
    return { status: "ok", reply: replies[sessionIds.length - 1] ?? "ok", sessionId: session.id };
  };
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
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
  assert.match(texts[1] ?? "", /workspace disk/);
  assert.doesNotMatch(texts[1] ?? "", /Recent fires/);
  assert.doesNotMatch(texts[1] ?? "", /first <invoke name="execute">/);
  assert.doesNotMatch(texts[1] ?? "", /first \[invoke name="execute"\]/);
  const stored = await crons.get(cron.id);
  assert.equal(stored?.fireLog?.length, 2);
  assert.equal(stored?.fireLog?.[0]?.reply, 'first <invoke name="execute">');
});

test("an idempotency-skipped cron fire does not create fire log history", async () => {
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: {
      once: async () => false,
      committed: async () => true,
    },
    identity: createIdentityService(),
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
  assert.equal(after?.fireLog?.length ?? 0, 0, "duplicate slot does not look like a fire");
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

  const stored = await crons.get((await crons.list())[0]!.id);
  assert.equal(stored?.fireLog?.[0]?.reply, "[reply echoed cron runtime context; omitted]");
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

test("a scopeFloor fallback actor is never a non-internal (Slack-Connect) member", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    runAs: "scopeFloor",
    members: [{ id: "X1", type: "guest" }, member("U2")],
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.actor.externalId, "U2", "the Slack-Connect member must not be picked as the actor");
});

test("a scopeFloor cron whose only members are non-internal fails closed", async () => {
  const { crons, calls, scheduler } = harness();
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    runAs: "scopeFloor",
    members: [{ id: "X1", type: "guest" }],
  });
  await scheduler.runNow(cron.id);
  assert.equal(calls.length, 0);
  assert.equal((await crons.get(cron.id))?.enabled, false);
});

test("a failing cron fire is logged, not swallowed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const crons = createCronStore();
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
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
  scheduler.start(1000);
  t.mock.timers.tick(1000);
  for (let i = 0; i < 50 && !logged.some((l) => l.includes("[scheduler] fire failed")); i++) {
    await new Promise((r) => setImmediate(r));
  }
  scheduler.stop();
  assert.ok(
    logged.some((l) => l.includes("[scheduler] fire failed") && l.includes("boom")),
    "the fire error must reach the log",
  );
  const after = await crons.get(cron.id);
  assert.equal(after?.fireLog?.length, 1);
  assert.equal(after?.fireLog?.[0]?.status, "failed");
  assert.equal(after?.fireLog?.[0]?.note, "boom");
});

test("queue mode: fires claim the slot before running, and stale or lost claims never run", async () => {
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  let onFire: ((job: { cronId: string; scheduledAt: number }) => Promise<void>) | undefined;
  const enqueued: Array<{ cronId: string; scheduledAt: number }> = [];
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "OUT" };
    },
    jobQueue: {
      async start(handlers) {
        onFire = handlers.onFire;
      },
      async enqueueFire(job) {
        enqueued.push(job);
      },
      healthy: () => true,
      async stop() {},
    },
  });
  scheduler.start(1000);
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "post the standup",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
  });
  for (let i = 0; i < 20 && !onFire; i++) await new Promise((r) => setImmediate(r));
  assert.ok(onFire, "queue mode registers the fire handler");
  scheduler.notifyChanged(cron.id);
  for (let i = 0; i < 20 && !enqueued.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(enqueued.pop(), { cronId: cron.id, scheduledAt: 1 }, "notifyChanged prompt-schedules the slot");

  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  assert.equal(calls.length, 1, "the job for the due slot fires");
  assert.ok((await crons.get(cron.id))!.lastFiredAt, "the claim advanced the schedule");
  assert.deepEqual(enqueued.pop()?.cronId, cron.id, "the next slot is chained");

  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  assert.equal(calls.length, 1, "a duplicate job for a claimed slot does not run the turn");
  scheduler.stop();
});

test("queue mode: while the queue runs, the interval scheduler's leader lease is held as a guard", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const heldKeys: string[] = [];
  const scheduler = createScheduler({
    crons: createCronStore(),
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async () => ({ status: "ok", reply: "OUT" }),
    leaderLease: {
      async hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
        heldKeys.push(key);
        return fn(new Promise<void>(() => {}));
      },
    },
    jobQueue: { async start() {}, async enqueueFire() {}, healthy: () => queueHealthy, async stop() {} },
  });
  let queueHealthy = true;
  scheduler.start(1000);
  for (let i = 0; i < 50 && !heldKeys.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    heldKeys,
    ["cron:scheduler:tick"],
    "the guard occupies the old tick lease so a blue-green peer cannot scan",
  );

  queueHealthy = false;
  heldKeys.length = 0;
  t.mock.timers.tick(5000);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(heldKeys, [], "an unhealthy queue holds nothing");
  scheduler.stop();
});

test("queue mode: an authz-failed fire disables the cron but gives the slot back (parity with the interval path)", async () => {
  const crons = createCronStore();
  const identity = createIdentityService();
  let onFire: ((job: { cronId: string; scheduledAt: number }) => Promise<void>) | undefined;
  const calls: TurnRequest[] = [];
  const scheduler = createScheduler({
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity,
    run: async (req) => {
      calls.push(req);
      return { status: "ok", reply: "OUT" };
    },
    jobQueue: {
      async start(handlers) {
        onFire = handlers.onFire;
      },
      async enqueueFire() {},
      healthy: () => true,
      async stop() {},
    },
  });
  scheduler.start(1000);
  const cron = await crons.create({
    schedule: { everyMs: 1000, firstFireAt: 1 },
    action: "my digest",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
  });
  await identity.deactivate("U1");
  for (let i = 0; i < 20 && !onFire; i++) await new Promise((r) => setImmediate(r));
  await onFire!({ cronId: cron.id, scheduledAt: 1 });
  const after = (await crons.get(cron.id))!;
  assert.equal(calls.length, 0, "no turn runs for a departed owner");
  assert.equal(after.enabled, false, "the cron fails closed");
  assert.equal(after.lastFiredAt, undefined, "the slot is not consumed by the authz failure");
  assert.equal(after.nextFireAt, 1, "a later re-enable still owes this fire");
  scheduler.stop();
});
