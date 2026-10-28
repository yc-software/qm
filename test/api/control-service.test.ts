import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../../src/types.ts";
import { runNowSettled } from "../support/settle.ts";
import { markFired } from "../support/cron-slots.ts";
import { ROOM, claims, setup } from "../support/control-service-app.ts";
import { buildApp } from "../support/build-app.ts";
import { createControlService } from "../../src/api/control-service.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../../src/auth/capability-token.ts";
import { testConfig } from "../support/test-config.ts";

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
    request,
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

test("every unattended read grant type is accepted on create", async () => {
  const { control } = setup();
  const grants = [
    "admin.sessions.read",
    "admin.audit.read",
    "admin.egress.read",
    "admin.files.read",
    "admin.spend.read",
    "admin.crons.read",
  ];
  const created = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, action: "nightly usage analysis", unattendedGrants: grants },
    claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true }),
  );
  assert.ok(created.ok, JSON.stringify(created));
  assert.deepEqual(created.ok ? created.cron.unattendedGrants : undefined, grants);
});

test("a grant-carrying cron delivers only to its owner: shared or third-party destinations are refused at create", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "admin-alice", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "User Two", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [{ channelId: "C-spend", name: "spend", isPrivate: false }],
    [{ channelId: "C-spend", principalId: "admin-alice" }],
  );
  const live = claims("admin-alice", scopeId("personal", "admin-alice"), { liveActor: true });
  const request = {
    schedule: { cron: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
    action: "daily spend review",
    unattendedGrants: ["admin.spend.read"],
  };

  for (const elsewhere of [{ channel: "spend" }, { recipient: "User Two" }]) {
    const refused = await control.createCron({ ...request, ...elsewhere }, live);
    assert.equal(refused.ok, false, JSON.stringify(elsewhere));
    assert.match(refused.ok ? "" : refused.message, /delivers only to them/);
  }

  const own = await control.createCron(request, live);
  assert.ok(own.ok, JSON.stringify(own));
  assert.equal(own.cron.ownerScopeId, scopeId("personal", "admin-alice"));

  const cleared = await control.patchCron(own.cron.id, { unattendedGrants: [] }, claims("admin-alice"));
  assert.ok(cleared.ok, "removing grants only narrows access, so it needs no live admin turn");
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

test("cron create with no named target delivers to this conversation, and returns the created cron", async () => {
  const { control } = setup();
  const r = await control.createCron(
    {
      title: "Gmail digest",
      schedule: { everyMs: 3_600_000 },
      action: "check gmail",
      unfurlLinks: false,
    },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.title, "Gmail digest");
  assert.equal(r.cron.action, "check gmail");
  assert.equal(r.cron.owner, "U1");
  assert.equal(r.cron.ownerScopeId, scopeId("personal", "U1"));
  assert.equal(r.cron.destination?.target, "D1");
  assert.equal(r.cron.destination?.unfurlLinks, false);
});

for (const state of ["active", "paused", "archived", "completed"] as const) {
  test(`cron creation is not limited by 101 ${state} tasks owned by the same person`, async () => {
    const { built, control } = setup();
    const firstFireAt = Date.now() + 60_000;
    for (let i = 0; i < 101; i++) {
      const cron = await built.crons.create({
        owner: "U1",
        ownerScopeId: scopeId("personal", "U1"),
        createdBy: "U1",
        schedule: state === "completed" ? { firstFireAt } : { everyMs: 3_600_000 },
        action: `existing task ${i}`,
      });
      if (state === "paused") await built.crons.setEnabled(cron.id, false);
      if (state === "archived") await built.crons.update(cron.id, { archived: true });
      if (state === "completed") await markFired(built.crons, cron.id, firstFireAt);
    }
    assert.equal((await built.crons.list()).length, 101);
    const created = await control.createCron(
      { title: "New task", schedule: { everyMs: 3_600_000 }, action: "new task" },
      claims("U1"),
    );
    assert.ok(created.ok, JSON.stringify(created));
    assert.equal(created.cron.owner, "U1");
    assert.equal(created.cron.enabled, true);
    assert.equal((await built.crons.list()).length, 102);
  });
}

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

test("a recurring cron addressed to a teammate targets them directly and sends nothing at creation", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob Jones", type: "internal" },
  ]);
  const r = await control.createCron(
    {
      title: "daily ping",
      schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
      text: "standup notes are due",
      recipient: "Bob",
    },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.cron.destination?.target, "U2");
  assert.equal((await built.posts.pending("principal")).length, 0);
});

test("a recurring teammate cron stops delivering once the recipient is no longer an addressable teammate", async () => {
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const r = await control.createCron(
    { schedule: { everyMs: 3_600_000 }, text: "standup notes are due", recipient: "Bob" },
    claims("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  await runNowSettled(built.scheduler, built.crons, r.cron.id);
  assert.deepEqual(
    (await built.posts.pending("principal")).map((d) => [d.destination.target, d.text]),
    [["U2", "standup notes are due"]],
  );
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "guest" },
  ]);
  await runNowSettled(built.scheduler, built.crons, r.cron.id);
  assert.equal((await built.posts.pending("principal")).length, 1);
  assert.equal((await built.crons.listFires(r.cron.id)).runs.at(-1)?.status, "refused");
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

test("recipient AND channel together is rejected", async () => {
  const { control } = setup();
  const r = await control.createCron(
    { schedule: { firstFireAt: Date.now() }, text: "hi", recipient: "Bob", channel: "eng" },
    claims("U1"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "bad_request");
});

test("a channel cron belongs to its creator: members see it, only the owner or a write grantee changes it", async () => {
  const chanScope = scopeId("channel", "C9");
  const chanClaims = (actor: string) =>
    claims(actor, chanScope, {
      privateScope: true,
      destination: { type: ROOM.type, target: ROOM.target, audienceScopeId: chanScope },
      destinations: [{ ...ROOM, audienceScopeId: chanScope }],
      defaultDestinationKey: ROOM.key,
    });
  const { built, control } = setup();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Una", type: "internal" },
    { principalId: "U2", displayName: "Mia", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [{ channelId: "C9", name: "eng", isPrivate: true }],
    ["U1", "U2"].map((principalId) => ({ channelId: "C9", principalId })),
  );

  const made = await control.createCron(
    { title: "digest", schedule: { everyMs: 60_000 }, action: "digest" },
    chanClaims("U1"),
  );
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.cron.owner, "U1");

  const seen = await control.getCron(made.cron.id, chanClaims("U2"));
  assert.ok(seen.ok, "a channel member can read the cron");
  const refused = await control.patchCron(made.cron.id, { title: "mine now" }, chanClaims("U2"));
  assert.equal(refused.ok ? "" : refused.code, "forbidden", "a member without write access can't change it");
  const outsider = await control.deleteCron(made.cron.id, claims("U9", scopeId("personal", "U9")));
  assert.equal(outsider.ok, false);

  const shared = await control.shareArtifact(
    { type: "cron", id: made.cron.id, scope: "personal:U2", permission: "write" },
    chanClaims("U1"),
  );
  assert.ok(shared.ok, JSON.stringify(shared));
  const granted = await control.patchCron(made.cron.id, { title: "weekly digest" }, chanClaims("U2"));
  assert.ok(granted.ok, JSON.stringify(granted));
  const reshared = await control.shareArtifact(
    { type: "cron", id: made.cron.id, scope: "personal:U9", permission: "write" },
    chanClaims("U2"),
  );
  assert.equal(reshared.ok ? "" : reshared.code, "forbidden", "a grantee can't pass write access on");
  assert.equal(granted.cron.owner, "U1", "a grantee's edit leaves the owner, and the owner's access, unchanged");

  const fromDm = await control.setCronEnabled(made.cron.id, false, claims("U1"));
  assert.ok(fromDm.ok, "the owner manages it from their DM");

  const conversational = await built.app.createCron({
    owner: "system:channel:C9",
    createdBy: "system:channel:C9",
    ownerScopeId: chanScope,
    schedule: { everyMs: 60_000 },
    action: "tidy",
  });
  assert.ok((await control.patchCron(conversational.id, { title: "renamed" }, chanClaims("U2"))).ok);
  await built.app.grant({
    ownerScopeId: chanScope,
    ref: `cron:${conversational.id}`,
    granteeScopeId: scopeId("personal", "U9"),
    permission: "write",
    grantedBy: "U2",
  });
  const outsiderEdit = await control.patchCron(conversational.id, { title: "mine" }, claims("U9"));
  assert.equal(
    outsiderEdit.ok ? "" : outsiderEdit.code,
    "forbidden",
    "only current members manage the conversation's cron",
  );

  const personal = await control.createCron(
    { title: "inbox", schedule: { everyMs: 60_000 }, action: "triage" },
    claims("U1"),
  );
  assert.ok(personal.ok);
  const personalShare = await control.shareArtifact(
    { type: "cron", id: personal.cron.id, scope: "personal:U2", permission: "write" },
    claims("U1"),
  );
  assert.equal(
    personalShare.ok ? "" : personalShare.code,
    "bad_request",
    "a personal cron runs with the whole keychain",
  );
  await built.app.grant({
    ownerScopeId: personal.cron.ownerScopeId,
    ref: `cron:${personal.cron.id}`,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "write",
    grantedBy: "U1",
  });
  const viaOldGrant = await control.patchCron(personal.cron.id, { action: "exfiltrate" }, claims("U2"));
  assert.equal(viaOldGrant.ok ? "" : viaOldGrant.code, "forbidden", "an older write grant can't steer a personal cron");
});

test("app.turn keeps the automation origin's owner-keychain union on the persisted run request", async () => {
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
    async: true,
  };
  const withUnion = await built.app.turn({ ...base, origin: { kind: "automation", useOwnerKeychain: true } });
  assert.equal(withUnion.status, "queued");
  const runU = await built.runs.get((withUnion as { runId?: string }).runId!);
  assert.deepEqual(runU?.request.origin, { kind: "automation", useOwnerKeychain: true });

  const typed = await built.app.turn({
    ...base,
    conversation: { ...base.conversation, threadRef: "t-typed-origin" },
    origin: { kind: "automation", screenData: "external event" },
  });
  const runT = await built.runs.get((typed as { runId?: string }).runId!);
  assert.deepEqual(runT?.request.origin, { kind: "automation", screenData: "external event" });
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

  const del = await control.deleteCron(id, claims("U1"));
  assert.ok(del.ok);
  const gone = await control.getCron(id, claims("U1"));
  assert.equal(gone.ok, false);
  assert.equal(gone.ok ? "" : gone.code, "not_found");
});

test(
  "pg: a linked identity manages its own cron in a private channel whose roster lists the linked email",
  { timeout: 60_000 },
  async () => {
    const built = buildApp(testConfig({ databaseUrl: process.env.DATABASE_URL! }));
    try {
      const control = createControlService(built.app, built.scheduler, built.admin);
      const email = "person@example.com";
      const canonical = "oidc|person";
      const room = scopeId("channel", "C-room");
      const channel = { channelId: "C-room", name: "room", isPrivate: true };
      const destination = { type: "slack", target: "C-room", audienceScopeId: room } as const;
      const claims = (actorId: string): CapabilityClaims => ({
        actorId,
        scopeId: room,
        privateScope: true,
        destination,
        destinations: [{ key: "k-room", label: "#room", ...destination }],
        defaultDestinationKey: "k-room",
        exp: Date.now() + CAPABILITY_TTL_MS,
      });
      const makeCron = () =>
        built.app.createCron({
          title: "Room digest",
          action: "summarize the channel",
          schedule: { everyMs: 3_600_000 },
          owner: canonical,
          createdBy: canonical,
          ownerScopeId: room,
        });

      await built.app.upsertDirectory([{ principalId: email, displayName: "Person", type: "internal" }]);
      await built.app.upsertChannels([channel], [{ channelId: "C-room", principalId: email }]);
      await built.principalLinks.link({
        principalId: email,
        canonicalId: canonical,

        linkedBy: canonical,
      });
      assert.equal(await built.directory.get(canonical), null, "the directory row stays keyed by the linked email");

      const cron = await makeCron();
      const disabled = await control.setCronEnabled(cron.id, false, claims(canonical));
      assert.ok(disabled.ok, JSON.stringify(disabled));
      assert.equal((await built.app.getCron(cron.id))?.enabled, false);
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), true);
      assert.equal((await control.deleteCron(cron.id, claims("someone-else"))).ok, false);
      const deleted = await control.deleteCron(cron.id, claims(canonical));
      assert.ok(deleted.ok, JSON.stringify(deleted));
      assert.equal(await built.app.getCron(cron.id), null);

      const kept = await makeCron();
      await built.app.upsertChannels([channel], []);
      assert.equal((await control.deleteCron(kept.id, claims(canonical))).ok, false, "removed from the room");
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), false);

      await built.app.upsertChannels([channel], [{ channelId: "C-room", principalId: email }]);
      await built.principalLinks.unlink(email);
      assert.equal((await control.deleteCron(kept.id, claims(canonical))).ok, false, "no longer the same person");
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), false);
      assert.ok(await built.app.getCron(kept.id));
    } finally {
      await built.runtime.stop();
    }
  },
);
