import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createUserCache,
  classifyUser,
  slackUserTimezone,
  probeIdentityMode,
  computeChannelAudience,
  computePublishMembers,
  allInternalChannelMembers,
  isMpim,
  isExternallyShared,
  externalMarker,
  groupDmDisplayName,
  resolveChannelMembership,
  type ActorAssertion,
} from "../src/slack/lib.ts";

const TEAM = "T-OWN";

test("createUserCache returns a fresh entry, then expires it past the TTL (fail-closed window stays bounded)", async () => {
  const c = createUserCache({ ttlMs: 120 });
  assert.equal(c.get("U"), undefined);
  c.set("U", { actor: { externalId: "U", displayName: "Reg" }, timezone: "America/Los_Angeles" });
  assert.deepEqual(c.get("U"), { actor: { externalId: "U", displayName: "Reg" }, timezone: "America/Los_Angeles" });
  await sleep(250);
  assert.equal(c.get("U"), undefined);
});

test("createUserCache evicts the least-recently-used entry past capacity, and a get() refreshes recency", () => {
  const c = createUserCache({ ttlMs: 10_000, max: 2 });
  c.set("A", { actor: { externalId: "A" } });
  c.set("B", { actor: { externalId: "B" } });
  assert.ok(c.get("A"));
  c.set("C", { actor: { externalId: "C" } });
  assert.ok(c.get("A"));
  assert.equal(c.get("B"), undefined);
  assert.ok(c.get("C"));
});

test("classifyUser flags guests, strangers, and other-workspace members as non-internal", () => {
  assert.equal(classifyUser({ id: "U1", team_id: TEAM }, TEAM).isExternalGuest, false);
  assert.equal(classifyUser({ id: "U2", team_id: TEAM, is_restricted: true }, TEAM).isExternalGuest, true);
  assert.equal(classifyUser({ id: "U3", team_id: TEAM, is_ultra_restricted: true }, TEAM).isExternalGuest, true);
  assert.equal(classifyUser({ id: "U4", team_id: "T-OTHER" }, TEAM).isExternalGuest, true);
});

test("classifyUser fails closed when Slack returns no user record", () => {
  assert.equal(classifyUser(undefined, "T1").isExternalGuest, true);
});

test("classifyUser flags a deactivated (deleted) member as non-internal — offboarding fails closed", () => {
  assert.equal(classifyUser({ id: "U5", team_id: TEAM, deleted: true }, TEAM).isExternalGuest, true);
});

test("classifyUser email mode keys members on their normalized work email", () => {
  const a = classifyUser({ id: "U1", team_id: TEAM, profile: { email: " Alice@Example.com " } }, TEAM, "email");
  assert.equal(a.externalId, "alice@example.com");
  assert.equal(a.isExternalGuest, false);
});

test("classifyUser email mode fails closed to guest when a member has no visible email", () => {
  const a = classifyUser({ id: "U1", team_id: TEAM }, TEAM, "email");
  assert.equal(a.externalId, "U1");
  assert.equal(a.isExternalGuest, true);
});

test("classifyUser email mode keeps bots on their Slack id and non-guest", () => {
  const b = classifyUser({ id: "UBOT", team_id: TEAM, is_bot: true }, TEAM, "email");
  assert.equal(b.externalId, "UBOT");
  assert.equal(b.isExternalGuest, false);
  assert.equal(b.isBot, true);
});

test("classifyUser email mode still flags restricted/other-workspace members as guests", () => {
  const g = classifyUser(
    { id: "U2", team_id: TEAM, is_restricted: true, profile: { email: "g@acme.com" } },
    TEAM,
    "email",
  );
  assert.equal(g.externalId, "g@acme.com");
  assert.equal(g.isExternalGuest, true);
});

test("slackUserTimezone extracts only valid Slack user timezones", () => {
  assert.equal(slackUserTimezone({ id: "U1", tz: "America/Los_Angeles" }), "America/Los_Angeles");
  assert.equal(slackUserTimezone({ id: "U1", profile: { tz: "Europe/London" } }), "Europe/London");
  assert.equal(slackUserTimezone({ id: "U1", tz: "not-a-zone" }), undefined);
  assert.equal(slackUserTimezone({ id: "U1", tz: " America/Los_Angeles " }), "America/Los_Angeles");
  assert.equal(slackUserTimezone({ id: "U1", tz: "x".repeat(65) }), undefined);
});

test("probeIdentityMode: email when any own-team human shows one, slack-id when none do", () => {
  assert.equal(
    probeIdentityMode(
      [
        { id: "U1", team_id: TEAM, profile: { email: "a@acme.com" } },
        { id: "U2", team_id: TEAM },
      ],
      TEAM,
    ),
    "email",
  );
  assert.equal(
    probeIdentityMode(
      [
        { id: "U1", team_id: TEAM },
        { id: "U2", team_id: TEAM },
      ],
      TEAM,
    ),
    "slack-id",
  );
});

test("probeIdentityMode is undecided on a page of only bots, deleted members, and other workspaces", () => {
  const noise = [
    { id: "UBOT", team_id: TEAM, is_bot: true },
    { id: "U9", team_id: TEAM, deleted: true, profile: { email: "gone@acme.com" } },
    { id: "U4", team_id: "T-OTHER", profile: { email: "other@x.com" } },
  ];
  assert.equal(probeIdentityMode(noise, TEAM), "undecided");
  assert.equal(probeIdentityMode([...noise, { id: "U1", team_id: TEAM }], TEAM), "slack-id");
});

test("computeChannelAudience detects a guest MEMBER of a private channel, not just Connect (scenario 27)", () => {
  const actor = { externalId: "U1" };
  const guest = { externalId: "G1", isExternalGuest: true };
  const internal = { externalId: "U2", isExternalGuest: false };

  const aud = computeChannelAudience(actor, [internal, guest], { is_ext_shared: false });
  assert.ok(
    aud.some((m) => m.isExternalGuest),
    "guest member must appear in the audience → core refuses",
  );

  const ok = computeChannelAudience(actor, [internal], { is_ext_shared: false });
  assert.ok(ok.every((m) => !m.isExternalGuest));
  assert.ok(ok.some((m) => m.externalId === actor.externalId));
});

test("computeChannelAudience falls back to a Connect marker when membership is unreadable", () => {
  const actor = { externalId: "U1" };
  const aud = computeChannelAudience(actor, null, { is_ext_shared: true });
  assert.ok(aud.some((m) => m.isExternalGuest));
  assert.deepEqual(computeChannelAudience(actor, null, { is_ext_shared: false }), [actor]);
});

test("isMpim / isExternallyShared / externalMarker", () => {
  assert.equal(isMpim({ is_mpim: true }), true);
  assert.equal(isMpim({ is_mpim: false }), false);
  assert.equal(isExternallyShared({ is_pending_ext_shared: true }), true);
  assert.equal(externalMarker().isExternalGuest, true);
});

test("groupDmDisplayName renders Slack group DMs from internal member display names", () => {
  assert.equal(
    groupDmDisplayName([
      { externalId: "eric@acme", displayName: "eric" },
      { externalId: "eve@acme", displayName: "eve" },
      { externalId: "katherine@acme", displayName: "katherine" },
      { externalId: "lucas@acme", displayName: "lucas" },
      { externalId: "sean@acme", displayName: "sean" },
    ]),
    "eric, eve, katherine, lucas, sean",
  );
  assert.equal(
    groupDmDisplayName([
      { externalId: "eric@acme", displayName: "eric" },
      { externalId: "eric@acme", displayName: "eric" },
      { externalId: "guest", isExternalGuest: true, displayName: "guest" },
    ]),
    "eric",
  );
});

test("computePublishMembers: all-internal + complete → the deduped membership (incl. actor)", () => {
  const actor = { externalId: "U1", isExternalGuest: false };
  const members = [
    { externalId: "U1", isExternalGuest: false },
    { externalId: "U2", isExternalGuest: false },
  ];
  const snap = computePublishMembers(actor, members, true, { is_ext_shared: false });
  assert.deepEqual((snap ?? []).map((m) => m.externalId).sort(), ["U1", "U2"]);
});

test("computePublishMembers: WITHHELD (undefined → owner-only) on incompleteness", () => {
  const actor = { externalId: "U1", isExternalGuest: false };
  const ok = [{ externalId: "U2", isExternalGuest: false }];
  assert.equal(
    computePublishMembers(actor, ok, false, { is_ext_shared: false }),
    undefined,
    "per-member/over-cap incompleteness",
  );
});

test("computePublishMembers: WITHHELD on a Connect channel or any guest present", () => {
  const actor = { externalId: "U1", isExternalGuest: false };
  const internalOnly = [{ externalId: "U2", isExternalGuest: false }];
  assert.equal(
    computePublishMembers(actor, internalOnly, true, { is_ext_shared: true }),
    undefined,
    "Connect → owner-only",
  );
  const withGuest = [{ externalId: "G1", isExternalGuest: true }];
  assert.equal(
    computePublishMembers(actor, withGuest, true, { is_ext_shared: false }),
    undefined,
    "a guest present → owner-only",
  );
});

test("allInternalChannelMembers: all-internal + complete → deduped ids; WITHHELD on guest / Connect / incomplete", () => {
  const internal = [
    { externalId: "U1", isExternalGuest: false },
    { externalId: "U2", isExternalGuest: false },
    { externalId: "U1", isExternalGuest: false },
  ];
  assert.deepEqual((allInternalChannelMembers(internal, true, { is_private: true }) ?? []).sort(), ["U1", "U2"]);
  assert.equal(allInternalChannelMembers(internal, false, { is_private: true }), undefined, "incomplete → withheld");
  const withGuest = [
    { externalId: "U1", isExternalGuest: false },
    { externalId: "G1", isExternalGuest: true },
  ];
  assert.equal(
    allInternalChannelMembers(withGuest, true, { is_private: true }),
    undefined,
    "a guest present → withheld (G1)",
  );
  assert.equal(
    allInternalChannelMembers(internal, true, { is_private: true, is_ext_shared: true }),
    undefined,
    "Connect → withheld",
  );
  assert.deepEqual(
    allInternalChannelMembers([], true, { is_private: true }),
    [],
    "empty roster → empty (still all-internal)",
  );
});

test("bot accounts can hold shared-scope membership", () => {
  assert.deepEqual(
    allInternalChannelMembers(
      [
        { externalId: "U1", isExternalGuest: false },
        { externalId: "B1", isExternalGuest: false, isBot: true },
      ],
      true,
      { is_private: true },
    ),
    ["U1", "B1"],
  );
});

function membershipDeps(overrides: Partial<Parameters<typeof resolveChannelMembership>[0]> = {}) {
  const internal = (externalId: string): ActorAssertion => ({ externalId, isExternalGuest: false });
  const byId: Record<string, ActorAssertion> = {
    U1: internal("alice@acme.com"),
    U2: internal("bob@acme.com"),
  };
  return {
    memberIds: ["U1", "U2"],
    actor: internal("alice@acme.com"),
    actorSlackId: "U1",
    info: undefined,
    classify: async (id: string) => ({
      actor: byId[id] ?? { externalId: id, isExternalGuest: true },
      ok: Boolean(byId[id]),
    }),
    ...overrides,
  };
}

test("resolveChannelMembership (email mode): sender's email principal matches via their Slack id, not externalId", async () => {
  const { audience, publishMembers, slackIdsByPrincipal } = await resolveChannelMembership(membershipDeps());
  assert.ok(!audience.some((a) => a.isExternalGuest), "all-internal channel must NOT pick up an external marker");
  assert.deepEqual(new Set(audience.map((a) => a.externalId)), new Set(["alice@acme.com", "bob@acme.com"]));
  assert.ok(publishMembers, "complete all-internal roster keeps publishMembers");
  assert.equal(slackIdsByPrincipal?.get("alice@acme.com"), "U1");
  assert.equal(slackIdsByPrincipal?.get("bob@acme.com"), "U2");
});

test("resolveChannelMembership: a sender whose Slack id is NOT in the channel roster fails closed", async () => {
  const { audience } = await resolveChannelMembership(membershipDeps({ actorSlackId: "U-OUTSIDER" }));
  assert.ok(
    audience.some((a) => a.isExternalGuest),
    "not-in-channel sender → external marker (refused upstream)",
  );
});

test("resolveChannelMembership: never matches the sender's email against raw member ids (the email-mode regression)", async () => {
  const { audience } = await resolveChannelMembership(membershipDeps({ actorSlackId: "alice@acme.com" }));
  assert.ok(
    audience.some((a) => a.isExternalGuest),
    "an email is not a member id — only the real Slack id matches",
  );
});

test("resolveChannelMembership handles large channels and withholds publishMembers on incomplete classify", async () => {
  const big = Array.from({ length: 201 }, (_, i) => `U${i}`);
  const large = await resolveChannelMembership(
    membershipDeps({
      memberIds: big,
      actorSlackId: "U1",
      classify: async (id: string) => ({
        actor: { externalId: id === "U1" ? "alice@acme.com" : id, isExternalGuest: false },
        ok: true,
      }),
    }),
  );
  assert.equal(large.audience.length, 201);
  assert.ok(!large.audience.some((a) => a.isExternalGuest));
  assert.equal(large.publishMembers?.length, 201);

  const incomplete = await resolveChannelMembership(
    membershipDeps({
      memberIds: ["U1", "U-UNKNOWN"],
      classify: async (id: string) =>
        id === "U1"
          ? { actor: { externalId: "alice@acme.com", isExternalGuest: false }, ok: true }
          : { actor: { externalId: id, isExternalGuest: true }, ok: false },
    }),
  );
  assert.equal(incomplete.publishMembers, undefined, "incomplete roster → publishMembers withheld");
});
