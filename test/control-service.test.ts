import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createControlService, type ControlService } from "../src/api/control-service.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "control-service-test";

const D1 = {
  key: "k-dm",
  type: "slack",
  target: "D1",
  audienceScopeId: scopeId("personal", "U1"),
  label: "this DM",
} as const;
const ROOM = {
  key: "k-room",
  type: "slack",
  target: "C9",
  audienceScopeId: scopeId("channel", "C9"),
  label: "#eng",
} as const;

function claims(
  actorId: string,
  scope: ScopeId = scopeId("personal", actorId),
  extra: Partial<CapabilityClaims> = {},
): CapabilityClaims {
  return {
    actorId,
    scopeId: scope,
    destination: { type: D1.type, target: D1.target, audienceScopeId: D1.audienceScopeId },
    destinations: [D1, ROOM],
    defaultDestinationKey: D1.key,
    exp: Date.now() + CAPABILITY_TTL_MS,
    ...extra,
  };
}

function setup(): { built: BuiltApp; control: ControlService } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "control-svc-")), signingSecret: SECRET }));
  const control = createControlService(built.app, built.scheduler, built.admin);
  return { built, control };
}

test("unattended cron grants require a live org-admin owner and protect later patches", async () => {
  const { control } = setup();
  const grant = ["admin.sessions.read"];
  const request = { schedule: { everyMs: 3_600_000 }, action: "scan failures", unattendedGrants: grant };

  const unattended = await control.createCron(request, claims("admin-alice"));
  assert.deepEqual(unattended, {
    ok: false,
    code: "forbidden",
    message: "unattended grants require a live turn started by the cron owner",
  });

  const nonAdmin = await control.createCron(request, claims("U1", scopeId("personal", "U1"), { liveActor: true }));
  assert.equal(nonAdmin.ok, false);
  assert.match(nonAdmin.ok ? "" : nonAdmin.message, /current org admin/);

  const unknown = await control.createCron(
    { ...request, unattendedGrants: ["admin.everything"] },
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok ? "" : unknown.code, "bad_request");

  const shared = await control.createCron(
    { ...request, runAs: "scopeFloor" },
    claims("admin-alice", scopeId("channel", "C9"), {
      liveActor: true,
      members: [{ id: "admin-alice", type: "internal" }],
    }),
  );
  assert.equal(shared.ok, false);
  assert.equal(shared.ok ? "" : shared.code, "bad_request");

  const created = await control.createCron(
    request,
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.ok(created.ok, JSON.stringify(created));
  assert.deepEqual(created.cron.unattendedGrants, grant);

  const nonOwner = await control.patchCron(
    created.cron.id,
    { unattendedGrants: [] },
    claims("admin-bob", scopeId("personal", "admin-bob"), { liveActor: true }),
  );
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.ok ? "" : nonOwner.code, "forbidden");

  const tamper = await control.patchCron(created.cron.id, { action: "rewrite instructions" }, claims("admin-alice"));
  assert.equal(tamper.ok, false);
  assert.match(tamper.ok ? "" : tamper.message, /live turn/);

  const privilegedNoop = await control.patchCron(created.cron.id, { enabled: true }, claims("admin-alice"));
  assert.ok(privilegedNoop.ok, "a privileged cron no-op does not need a live grant reaffirmation");
  assert.deepEqual(privilegedNoop.ok ? privilegedNoop.cron.unattendedGrants : undefined, grant);

  const unattendedRun = await control.runCron(created.cron.id, claims("admin-alice"));
  assert.equal(unattendedRun.ok, false);
  assert.match(unattendedRun.ok ? "" : unattendedRun.message, /live turn/);

  const cleared = await control.patchCron(
    created.cron.id,
    { unattendedGrants: [] },
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.ok(cleared.ok, "a grants-only patch from the live owner is a real patch");
  assert.deepEqual(cleared.ok ? cleared.cron.unattendedGrants : undefined, []);
});

test("a raw unreaffirmed cron patch strips unattended grants; a live-owner patch reaffirms them", async () => {
  const { built, control } = setup();
  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "scan failures", unattendedGrants: ["admin.sessions.read"] },
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.ok(created.ok, JSON.stringify(created));
  const id = created.ok ? created.cron.id : "";

  const ownerPatch = await control.patchCron(
    id,
    { title: "renamed by owner" },
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.ok(ownerPatch.ok, JSON.stringify(ownerPatch));
  assert.deepEqual(
    ownerPatch.ok ? ownerPatch.cron.unattendedGrants : undefined,
    ["admin.sessions.read"],
    "a legitimate live-owner patch keeps the grant",
  );

  const tampered = await built.app.updateCron(id, { action: "attacker task" });
  assert.equal(tampered?.action, "attacker task");
  assert.deepEqual(tampered?.unattendedGrants, [], "a raw patch that does not reaffirm grants drops the cron to floor");
});

test("cron create with a destinationKey resolves to that menu destination, and returns the created cron", async () => {
  const { control } = setup();
  const r = await control.createCron(
    {
      title: "Gmail digest",
      schedule: { everyMs: 3_600_000 },
      action: "check gmail",
      destinationKey: ROOM.key,
      unfurlLinks: false,
    },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.title, "Gmail digest");
  assert.equal(r.cron.action, "check gmail");
  assert.equal(r.cron.owner, "U1");
  assert.equal(r.cron.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(r.cron.destination?.target, "C9");
  assert.equal(r.cron.destination?.unfurlLinks, false);
});

test("a calendar cron without an explicit timezone inherits the turn's timezone (not the global default)", async () => {
  const { built, control } = setup();
  const r = await control.createCron(
    { title: "standup", schedule: { cron: "0 9 * * 1-5" }, action: "post standup" },
    claims("U1", scopeId("personal", "U1"), { timezone: "Europe/Berlin" }),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const stored = await built.app.getCron(r.cron.id);
  assert.equal(stored?.schedule.timezone, "Europe/Berlin", "the turn timezone is applied, not America/Los_Angeles");

  const explicit = await control.createCron(
    { schedule: { cron: "0 9 * * *", timezone: "UTC" }, action: "x" },
    claims("U1", scopeId("personal", "U1"), { timezone: "Europe/Berlin" }),
  );
  assert.ok(explicit.ok);
  assert.equal((await built.app.getCron(explicit.cron.id))?.schedule.timezone, "UTC");

  const noTz = await control.createCron({ schedule: { cron: "0 9 * * *" }, action: "x" }, claims("U1"));
  assert.ok(noTz.ok);
  assert.equal((await built.app.getCron(noTz.cron.id))?.schedule.timezone, "America/Los_Angeles");
});

test("an unknown destinationKey is rejected (only menu keys are allowed)", async () => {
  const { control } = setup();
  const r = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", destinationKey: "not-a-real-key" },
    claims("U1"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "unknown_destination");
});

test("cron create rejects unfurlLinks when there is no delivery destination", async () => {
  const { control } = setup();
  const noDestinationClaims = {
    ...claims("U1"),
    destination: undefined,
    destinations: [],
    defaultDestinationKey: undefined,
  };
  const r = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", unfurlLinks: false },
    noDestinationClaims,
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "bad_request");
  assert.match(r.ok ? "" : r.message, /delivery destination/);
});

test("cron create with `recipient` resolves a teammate by name and runs at the sender's personal scope", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob Jones", type: "internal" },
  ]);
  const r = await control.createCron(
    { title: "ping bob", schedule: { firstFireAt: Date.now() }, text: "standup in 5", recipient: "Bob" },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.recipient?.principalId, "U2");
  assert.equal(r.recipient?.displayName, "Bob Jones");
  assert.equal(r.cron.destination?.type, "principal");
  assert.equal(r.cron.destination?.target, "U2");
  assert.equal(r.cron.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(r.cron.message, "standup in 5");
});

test("a RECURRING cron addressed to a teammate starts pending their consent and sends one notice", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob Jones", type: "internal" },
  ]);
  const r = await control.createCron(
    {
      title: "daily ping",
      schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      action: "summarize",
      recipient: "Bob",
    },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.recipientConsent?.recipientId, "U2");
  assert.equal(r.cron.recipientConsent?.status, "pending");
  const notices = await built.deliveries.pending("principal");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.destination.target, "U2");
  assert.match(notices[0]!.text, /set up .* to be delivered to you/);
});

test("a one-shot (firstFireAt) teammate DM needs no consent — a single scheduled message, like reach", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const r = await control.createCron(
    { schedule: { firstFireAt: Date.now() + 1000 }, text: "ping", recipient: "Bob" },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.recipientConsent, undefined);
  assert.equal((await built.deliveries.pending("principal")).length, 0, "no consent notice for a one-shot send");
});

test("a teammate-addressed cron runs in the OWNER's scope; the recipient is delivery-only (run scope ⊆ owner-accessible)", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const r = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", recipient: "Bob" },
    claims("U1", scopeId("channel", "C9")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.ownerScopeId, scopeId("channel", "C9"));
  assert.notEqual(r.cron.ownerScopeId, scopeId("personal", "U2"));
  const personal = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal" },
    claims("U1", scopeId("channel", "C9")),
  );
  assert.ok(personal.ok, JSON.stringify(personal));
  assert.equal(personal.cron.recipientConsent, undefined);
});

test("an ambiguous recipient name returns candidates, not a created cron", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U2", displayName: "Sam Lee", type: "internal" },
    { principalId: "U3", displayName: "Sam Park", type: "internal" },
  ]);
  const r = await control.createCron(
    { schedule: { firstFireAt: Date.now() }, text: "hi", recipient: "Sam" },
    claims("U1"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "ambiguous_recipient");
  assert.equal(r.ok ? 0 : r.candidates?.length, 2);
});

test("an unknown recipient is recipient_not_found", async () => {
  const { control } = setup();
  const r = await control.createCron(
    { schedule: { firstFireAt: Date.now() }, text: "hi", recipient: "Nobody" },
    claims("U1"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "recipient_not_found");
});

test("cron create with `channel` resolves a public channel; a private channel needs membership", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "User One", type: "internal" },
    { principalId: "U2", displayName: "User Two", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: "C-pub", name: "general", isPrivate: false },
      { channelId: "C-priv", name: "secret", isPrivate: true },
    ],
    [{ channelId: "C-priv", principalId: "U1" }],
  );
  const pub = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post", channel: "general" },
    claims("U1"),
  );
  assert.ok(pub.ok, JSON.stringify(pub));
  assert.equal(pub.channel?.channelId, "C-pub");
  assert.equal(pub.cron.ownerScopeId, scopeId("channel", "C-pub"));
  assert.equal(pub.cron.destination?.target, "C-pub");

  const privOk = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post", channel: "secret" },
    claims("U1"),
  );
  assert.ok(privOk.ok, JSON.stringify(privOk));

  const privNo = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post", channel: "secret" },
    claims("U2"),
  );
  assert.equal(privNo.ok, false);
  assert.equal(privNo.ok ? "" : privNo.code, "not_a_member");

  const ghost = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "post", channel: "secret" },
    claims("U-ghost"),
  );
  assert.equal(ghost.ok, false);
  assert.equal(ghost.ok ? "" : ghost.code, "identity_unverified");
});

test('scope:"personal" runs at the invoking user\'s personal scope and DMs them, even from a channel', async () => {
  const { control } = setup();
  const chanScope = scopeId("channel", "C9");
  const r = await control.createCron(
    { title: "my private reminder", schedule: { everyMs: 3_600_000 }, action: "remind me", scope: "personal" },
    claims("U1", chanScope),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(r.cron.destination?.type, "principal");
  assert.equal(r.cron.destination?.target, "U1");
  assert.equal(r.cron.destination?.audienceScopeId, scopeId("personal", "U1"));
  assert.equal(r.recipient, undefined);
  assert.equal(r.channel, undefined);
});

test('scope:"personal" can\'t be combined with an addressed target, a destinationKey, or scopeFloor', async () => {
  const { control } = setup();
  const withChannel = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal", channel: "eng" },
    claims("U1"),
  );
  assert.equal(withChannel.ok, false);
  assert.equal(withChannel.ok ? "" : withChannel.code, "bad_request");

  const withKey = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal", destinationKey: ROOM.key },
    claims("U1"),
  );
  assert.equal(withKey.ok, false);
  assert.equal(withKey.ok ? "" : withKey.code, "bad_request");

  const withFloor = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal", runAs: "scopeFloor" },
    claims("U1", scopeId("channel", "C9")),
  );
  assert.equal(withFloor.ok, false);
  assert.equal(withFloor.ok ? "" : withFloor.code, "bad_request");
});

test('scope:"personal" ignores an empty participants array (tool callers often send []), but a non-empty one conflicts', async () => {
  const { control } = setup();
  const ok = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal", participants: [] },
    claims("U1", scopeId("channel", "C9")),
  );
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.cron.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(ok.cron.destination?.type, "principal");
  assert.equal(ok.cron.destination?.target, "U1");
  const bad = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", scope: "personal", participants: ["U2"] },
    claims("U1", scopeId("channel", "C9")),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? "" : bad.code, "bad_request");
});

test("recipient AND channel together is rejected", async () => {
  const { control } = setup();
  const r = await control.createCron(
    { schedule: { firstFireAt: Date.now() }, text: "hi", recipient: "Bob", channel: "eng" },
    claims("U1"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "bad_request");
});

test("runAs=scopeFloor needs the conversation member list; with it, the cron is a team cron", async () => {
  const { control } = setup();
  const chanScope = scopeId("channel", "C9");
  const noMembers = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "team digest", runAs: "scopeFloor" },
    claims("U1", chanScope),
  );
  assert.equal(noMembers.ok, false);
  assert.equal(noMembers.ok ? "" : noMembers.code, "members_unavailable");

  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const withMembers = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "team digest", runAs: "scopeFloor" },
    claims("U1", chanScope, {
      members,
      privateScope: true,
      destination: { type: ROOM.type, target: ROOM.target, audienceScopeId: chanScope },
      destinations: [{ ...ROOM, audienceScopeId: chanScope }],
      defaultDestinationKey: ROOM.key,
    }),
  );
  assert.ok(withMembers.ok, JSON.stringify(withMembers));
  assert.equal(withMembers.cron.runAs, "scopeFloor");
  assert.equal(withMembers.cron.ownerScopeId, chanScope);
});

test("authority follows the person, not the conversation: members administer a channel-made team cron from their DMs; an ex-member (even the creator) loses it", async () => {
  const chanScope = scopeId("channel", "C9");
  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const chanClaims = (actor: string) =>
    claims(actor, chanScope, {
      members,
      privateScope: true,
      destination: { type: ROOM.type, target: ROOM.target, audienceScopeId: chanScope },
      destinations: [{ ...ROOM, audienceScopeId: chanScope }],
      defaultDestinationKey: ROOM.key,
    });
  const pushMembers = (built: BuiltApp, ids: string[]) =>
    built.app.upsertChannels(
      [{ channelId: "C9", name: "eng", isPrivate: true }],
      ids.map((principalId) => ({ channelId: "C9", principalId })),
    );

  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Una", type: "internal" },
    { principalId: "U2", displayName: "Mia", type: "internal" },
  ]);
  await pushMembers(built, ["U1", "U2"]);

  const made = await control.createCron(
    { title: "minute pings", schedule: { everyMs: 60_000 }, action: "ping", runAs: "scopeShared" },
    chanClaims("U1"),
  );
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.cron.runAs, "scopeShared", "a private-channel cron defaults to the team mode");

  const dmClaims = claims("U1");
  const listed = await control.listCrons(dmClaims);
  assert.ok(
    listed.crons.some((c) => c.id === made.cron.id),
    "the owner's DM list includes the channel-made cron",
  );
  const disabled = await control.setCronEnabled(made.cron.id, false, dmClaims);
  assert.ok(disabled.ok, JSON.stringify(disabled));

  const memberFromDm = await control.deleteCron(made.cron.id, claims("U2", scopeId("personal", "U2")));
  assert.ok(memberFromDm.ok, "a current member administers the team cron from anywhere");
  const outsider = await control.createCron(
    { title: "digest", schedule: { everyMs: 60_000 }, action: "digest", runAs: "scopeShared" },
    chanClaims("U1"),
  );
  assert.ok(outsider.ok, JSON.stringify(outsider));
  const nonMember = await control.deleteCron(outsider.cron.id, claims("U9", scopeId("personal", "U9")));
  assert.equal(nonMember.ok, false, "a non-member can't touch the team cron from their DM");

  await pushMembers(built, ["U2"]);
  const exMember = await control.deleteCron(outsider.cron.id, claims("U1"));
  assert.equal(exMember.ok, false, "the creator lost channel membership, so they lost the team cron");
  const stillMember = await control.deleteCron(outsider.cron.id, claims("U2", scopeId("personal", "U2")));
  assert.ok(stillMember.ok, JSON.stringify(stillMember));
});

test("scopeShared is explicit: shared-scope crons default to owner, while collaborators can opt into owner∪scope creds", async () => {
  const chanScope = scopeId("channel", "C9");
  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const chanClaims = (actor: string) =>
    claims(actor, chanScope, {
      members,
      privateScope: true,
      destination: { type: ROOM.type, target: ROOM.target, audienceScopeId: chanScope },
      destinations: [{ ...ROOM, audienceScopeId: chanScope }],
      defaultDestinationKey: ROOM.key,
    });

  const { built, control } = setup();
  const ownerDefault = await control.createCron(
    { title: "private digest", schedule: { everyMs: 3_600_000 }, action: "private digest" },
    chanClaims("U1"),
  );
  assert.ok(ownerDefault.ok, JSON.stringify(ownerDefault));
  assert.equal(
    ownerDefault.cron.runAs,
    undefined,
    "shared-room creation does not silently share the owner's credentials or administration",
  );

  const ok = await control.createCron(
    { title: "expo digest", schedule: { everyMs: 3_600_000 }, action: "team digest", runAs: "scopeShared" },
    chanClaims("U1"),
  );
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.cron.runAs, "scopeShared");
  assert.equal(ok.cron.owner, "U1");
  assert.equal(ok.cron.ownerScopeId, chanScope);
  assert.deepEqual(
    ok.cron.members?.map((m) => m.id),
    ["U1", "U2"],
  );

  const ownerExplicit = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", runAs: "owner" },
    chanClaims("U1"),
  );
  assert.ok(ownerExplicit.ok, JSON.stringify(ownerExplicit));
  assert.notEqual(ownerExplicit.cron.runAs, "scopeShared");

  const editNotices = async () =>
    (await built.deliveries.pending("principal")).filter((d) => d.idempotencyKey.startsWith("cron-edit-notice:"));

  const byMember = await control.patchCron(ok.cron.id, { title: "expo digest v2" }, chanClaims("U2"));
  assert.ok(byMember.ok, JSON.stringify(byMember));
  assert.equal(byMember.cron.title, "expo digest v2");
  const afterMemberEdit = await editNotices();
  assert.equal(afterMemberEdit.length, 1, "non-owner edit via control service notifies the owner");
  assert.equal(afterMemberEdit[0]!.destination.target, "U1");

  const memberNoop = await control.patchCron(ok.cron.id, { title: "expo digest v2" }, chanClaims("U2"));
  assert.ok(memberNoop.ok, JSON.stringify(memberNoop));
  assert.equal((await editNotices()).length, 1, "same-value member edit produces no notice");

  const memberChange = await control.patchCron(ok.cron.id, { title: "expo digest v3" }, chanClaims("U2"));
  assert.ok(memberChange.ok, JSON.stringify(memberChange));
  assert.equal((await editNotices()).length, 2, "a later real member edit still notifies the owner");

  await control.patchCron(ok.cron.id, { title: "owner tweak" }, chanClaims("U1"));
  assert.equal((await editNotices()).length, 2, "owner self-edit produces no notice");

  const byOutsider = await control.patchCron(
    ok.cron.id,
    { title: "nope" },
    claims("U9", scopeId("channel", "C-other")),
  );
  assert.equal(byOutsider.ok, false);
  assert.equal(byOutsider.ok ? "" : byOutsider.code, "forbidden");

  const personalDefault = await control.createCron({ schedule: { everyMs: 3_600_000 }, action: "x" }, claims("U1"));
  assert.ok(personalDefault.ok && personalDefault.cron.runAs === undefined, "personal cron defaults to owner");
  const personal = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", runAs: "scopeShared" },
    claims("U1", scopeId("personal", "U1"), { members }),
  );
  assert.equal(personal.ok, false);
  assert.equal(personal.ok ? "" : personal.code, "bad_request");
});

test("scopeShared is confined to membership-controlled scopes: a public channel defaults to owner and rejects explicit scopeShared", async () => {
  const { control } = setup();
  const pubScope = scopeId("channel", "C-PUBLIC");
  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const pub = { key: "kp", type: "slack" as const, target: "C-PUBLIC", audienceScopeId: pubScope, label: "#pub" };
  const pubClaims = claims("U1", pubScope, {
    members,
    destination: { type: pub.type, target: pub.target, audienceScopeId: pubScope },
    destinations: [pub],
    defaultDestinationKey: pub.key,
  });

  const def = await control.createCron({ schedule: { everyMs: 3_600_000 }, action: "x" }, pubClaims);
  assert.ok(def.ok, JSON.stringify(def));
  assert.equal(def.cron.runAs, undefined);

  const explicit = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "x", runAs: "scopeShared" },
    pubClaims,
  );
  assert.equal(explicit.ok, false);
  assert.equal(explicit.ok ? "" : explicit.code, "bad_request");
});

test("app.createCron/updateCron backstop: scopeShared needs a shared scope + a member snapshot", async () => {
  const chanScope = scopeId("channel", "C9");
  const members = [{ id: "U1", type: "internal" as const }];
  const base = { schedule: { everyMs: 3_600_000 }, action: "x", owner: "U1", createdBy: "U1", members } as const;
  const { built } = setup();

  await assert.rejects(
    built.app.createCron({ ...base, ownerScopeId: scopeId("personal", "U1"), runAs: "scopeShared" }),
    /shared/,
  );
  const ok = await built.app.createCron({ ...base, ownerScopeId: chanScope, runAs: "scopeShared" });
  assert.equal(ok.runAs, "scopeShared");

  const ownerCron = await built.app.createCron({ ...base, ownerScopeId: scopeId("personal", "U1") });
  await assert.rejects(built.app.updateCron(ownerCron.id, { runAs: "scopeShared", members }), /shared/);
});

test("a cron's mode (runAs) is editable in place, but only by the owner", async () => {
  const { control } = setup();
  const chanScope = scopeId("channel", "C9");
  const members = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const chanClaims = (actor: string) =>
    claims(actor, chanScope, {
      members,
      privateScope: true,
      destination: { type: ROOM.type, target: ROOM.target, audienceScopeId: chanScope },
      destinations: [{ ...ROOM, audienceScopeId: chanScope }],
      defaultDestinationKey: ROOM.key,
    });

  const created = await control.createCron(
    { title: "t", schedule: { everyMs: 3_600_000 }, action: "x", runAs: "scopeShared" },
    chanClaims("U1"),
  );
  assert.ok(created.ok && created.cron.runAs === "scopeShared", JSON.stringify(created));
  const id = created.cron.id;

  const memberMode = await control.patchCron(id, { runAs: "scopeFloor" }, chanClaims("U2"));
  assert.equal(memberMode.ok, false);
  assert.equal(memberMode.ok ? "" : memberMode.code, "forbidden");

  const toFloor = await control.patchCron(id, { runAs: "scopeFloor" }, chanClaims("U1"));
  assert.ok(toFloor.ok && toFloor.cron.runAs === "scopeFloor", JSON.stringify(toFloor));
  const back = await control.patchCron(id, { runAs: "scopeShared" }, chanClaims("U1"));
  assert.ok(back.ok && back.cron.runAs === "scopeShared", JSON.stringify(back));
});

test("app.turn forwards ownerKeychainUnion onto the persisted run request (else scheduled fires lose the union)", async () => {
  const { built } = setup();
  const base = {
    surface: "cron",
    actor: { externalId: "U1" },
    conversation: {
      kind: "channel" as const,
      channelRef: "C9",
      threadRef: "t-union",
      audience: [{ externalId: "U1" }],
    },
    text: "compute digest",
    triggered: true,
    async: true,
  };
  const withUnion = await built.app.turn({ ...base, ownerKeychainUnion: true });
  assert.equal(withUnion.status, "queued");
  const runU = await built.runs.get((withUnion as { runId?: string }).runId!);
  assert.deepEqual(
    runU?.request.origin,
    { kind: "automation", useOwnerKeychain: true },
    "the union flag must survive app.turn → persisted run origin",
  );

  const without = await built.app.turn({ ...base, conversation: { ...base.conversation, threadRef: "t-nounion" } });
  const runN = await built.runs.get((without as { runId?: string }).runId!);
  assert.deepEqual(runN?.request.origin, { kind: "automation" });

  const typed = await built.app.turn({
    ...base,
    conversation: { ...base.conversation, threadRef: "t-typed-origin" },
    triggered: undefined,
    origin: { kind: "automation", screenData: "external event" },
  });
  const runT = await built.runs.get((typed as { runId?: string }).runId!);
  assert.deepEqual(runT?.request.origin, { kind: "automation", screenData: "external event" });

  const conflicted = await built.app.turn({
    ...base,
    conversation: { ...base.conversation, threadRef: "t-conflicting-origin" },
    origin: { kind: "human" },
    securityScreenData: "external event",
  });
  const runC = await built.runs.get((conflicted as { runId?: string }).runId!);
  assert.deepEqual(runC?.request.origin, { kind: "automation", screenData: "external event" });
});

test("cron list / get / patch / delete / run round-trip with owner authz", async () => {
  const { built, control } = setup();
  const updateCron = built.app.updateCron.bind(built.app);
  let updateCalls = 0;
  built.app.updateCron = async (id, patch) => {
    updateCalls += 1;
    return updateCron(id, patch);
  };
  const created = await control.createCron(
    { title: "orig", schedule: { everyMs: 3_600_000 }, action: "do x" },
    claims("U1"),
  );
  assert.ok(created.ok);
  const id = created.cron.id;

  const listed = await control.listCrons(claims("U1"));
  assert.ok("crons" in listed);
  assert.ok(listed.crons.some((c) => c.id === id));

  const otherGet = await control.getCron(id, claims("U9"));
  assert.equal(otherGet.ok, false);
  assert.equal(otherGet.ok ? "" : otherGet.code, "forbidden");

  const patched = await control.patchCron(
    id,
    { title: "renamed", schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" }, unfurlLinks: false },
    claims("U1"),
  );
  assert.ok(patched.ok, JSON.stringify(patched));
  assert.equal(patched.cron.title, "renamed");
  assert.equal(patched.cron.schedule.cron, "0 9 * * 1-5");
  assert.equal(patched.cron.destination?.unfurlLinks, false);
  assert.equal(updateCalls, 1);

  const same = await control.patchCron(
    id,
    { title: "renamed", schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" }, unfurlLinks: false },
    claims("U1"),
  );
  assert.ok(same.ok, JSON.stringify(same));
  assert.equal(same.cron.id, id);
  assert.equal(updateCalls, 1, "same-value patches return the cron without writing");

  const sameMode = await control.patchCron(id, { runAs: "owner" }, claims("U1"));
  assert.ok(sameMode.ok, JSON.stringify(sameMode));
  assert.equal(updateCalls, 1, "the current effective mode is a recognized no-op");

  const tooFrequent = await control.patchCron(id, { schedule: { everyMs: 1 } }, claims("U1"));
  assert.equal(tooFrequent.ok, false);
  assert.equal(tooFrequent.ok ? "" : tooFrequent.code, "cron_update_failed");
  const afterRejected = await control.getCron(id, claims("U1"));
  assert.ok(afterRejected.ok);
  assert.equal(afterRejected.ok ? afterRejected.cron.schedule.cron : null, "0 9 * * 1-5");

  const empty = await control.patchCron(id, {}, claims("U1"));
  assert.equal(empty.ok, false);
  assert.equal(empty.ok ? "" : empty.code, "bad_request");
  assert.match(empty.ok ? "" : empty.message, /nothing to change/);

  const disabled = await control.setCronEnabled(id, false, claims("U1"));
  assert.ok(disabled.ok);
  assert.equal(disabled.cron.enabled, false);
  const ranDisabled = await control.runCron(id, claims("U1"));
  assert.equal(ranDisabled.ok, false);
  assert.equal(ranDisabled.ok ? "" : ranDisabled.code, "bad_request");
  const reenabled = await control.setCronEnabled(id, true, claims("U1"));
  assert.ok(reenabled.ok);
  const ran = await control.runCron(id, claims("U1"));
  assert.ok(ran.ok, JSON.stringify(ran));

  const retargeted = await control.retargetCron(id, ROOM.key, claims("U1"));
  assert.ok(retargeted.ok, JSON.stringify(retargeted));
  assert.equal(retargeted.cron.destination?.target, "C9");

  const del = await control.deleteCron(id, claims("U1"));
  assert.ok(del.ok);
  const gone = await control.getCron(id, claims("U1"));
  assert.equal(gone.ok, false);
  assert.equal(gone.ok ? "" : gone.code, "not_found");
});

test("cron get honors read-only visibility: a delivery-targeted viewer reads, never administers", async () => {
  const { built, control } = setup();
  const created = await control.createCron(
    { title: "digest", schedule: { everyMs: 3_600_000 }, action: "do x" },
    claims("U1"),
  );
  assert.ok(created.ok);
  const id = created.cron.id;

  const before = await control.getCron(id, claims("U9"));
  assert.equal(before.ok, false, "no visibility yet — get stays forbidden");

  await built.app.setCronDestination(id, { type: "principal", target: "U9" });
  const seen = await control.getCron(id, claims("U9"));
  assert.ok(seen.ok, `a viewer in the visible set can read: ${JSON.stringify(seen)}`);
  assert.equal(seen.ok ? seen.cron.id : "", id);

  const patched = await control.patchCron(id, { title: "hijack" }, claims("U9"));
  assert.equal(patched.ok, false, "visibility never grants administration");
  assert.equal(patched.ok ? "" : patched.code, "forbidden");
});

test("webhook create surfaces the inbound url + the secret verbatim; list elides; disable is owner-gated", async () => {
  const { control } = setup();
  const r = await control.createWebhook(
    {
      action: "handle the event",
      verification: { scheme: "github", secret: "shh-secret" },
      filters: [{ path: "action", in: ["opened"] }],
    },
    claims("U1"),
    "https://portal.example",
  );
  assert.ok(r.ok, JSON.stringify(r));
  // The url is absolute (publicly reachable) and the secret is returned verbatim ONCE.
  assert.equal(r.url, `https://portal.example/v1/webhooks/incoming/${r.webhook.id}`);
  assert.equal(r.secret, "shh-secret");
  assert.equal(r.webhook.owner, "U1");

  const listed = await control.listWebhooks(claims("U1"));
  assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 1);

  // a different owner can't disable it
  const otherDisable = await control.disableWebhook(r.webhook.id, claims("U9"));
  assert.equal(otherDisable.ok, false);
  assert.equal(otherDisable.ok ? "" : otherDisable.code, "forbidden");

  const disabled = await control.disableWebhook(r.webhook.id, claims("U1"));
  assert.ok(disabled.ok);
});

test("soul read returns the effective SOUL; write replaces this scope's SOUL and bumps the version", async () => {
  const { control } = setup();
  const before = control.readSoul(claims("U1"));
  assert.equal(before.soul, null);

  const w = await control.writeSoul("Always greet in Spanish.", claims("U1"));
  assert.ok(w.ok, JSON.stringify(w));
  assert.equal(w.version, 1);

  const after = control.readSoul(claims("U1"));
  assert.equal(after.soul, "Always greet in Spanish.");
  assert.match(after.effectiveSoul, /Always greet in Spanish\./);
});

test("soul write in a shared (channel) scope is allowed (allowSharedScope, like the agent route)", async () => {
  const { control } = setup();
  const w = await control.writeSoul("Channel standing note.", claims("U1", scopeId("channel", "C9")));
  assert.ok(w.ok, JSON.stringify(w));
  const after = control.readSoul(claims("U1", scopeId("channel", "C9")));
  assert.equal(after.soul, "Channel standing note.");
});
