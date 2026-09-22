import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIsCurrentSharedScopeMember,
  withLiveRoster,
  type LiveRoster,
  type ScopeMembershipDeps,
} from "../src/resolution/scope-membership.ts";
import type { ScopeId } from "../src/types.ts";

const newGroup = "group:C0NEW" as ScopeId;
const knownGroup = "group:C0KNOWN" as ScopeId;
const live: LiveRoster = {
  actorId: "josh@example.com",
  members: [
    { id: "josh@example.com", type: "internal" },
    { id: "regan@example.com", type: "internal" },
  ],
};

function deps(overrides: Partial<NonNullable<ScopeMembershipDeps["directory"]>> = {}): ScopeMembershipDeps {
  return {
    directory: {
      channelMember: async () => false,
      // The store holds a roster only for C0KNOWN, and josh is not in it.
      groupMember: async (groupId, principalId) => groupId === "C0KNOWN" && principalId === "regan@example.com",
      conversationRosterKnown: async (_kind, id) => id === "C0KNOWN",
      ...overrides,
    },
  };
}

test("first turn in a room the store has not synced yet: the verified live roster stands in", async () => {
  const check = createIsCurrentSharedScopeMember(deps());
  assert.equal(await check("josh@example.com", newGroup), false, "no hint, no fallback");
  assert.equal(await check("josh@example.com", newGroup, live), true);
  // Only the speaker benefits, even if listed in the roster.
  assert.equal(await check("regan@example.com", newGroup, live), false);
  assert.equal(await check("mallory@example.com", newGroup, live), false);
});

test("a stored roster is authoritative: a room the store knows without the speaker stays closed", async () => {
  const check = createIsCurrentSharedScopeMember(deps());
  assert.equal(await check("josh@example.com", knownGroup, live), false);
  assert.equal(await check("regan@example.com", knownGroup), true);
});

test("no fallback for incomplete or non-internal rosters, managed groups, or non-shared scopes", async () => {
  const check = createIsCurrentSharedScopeMember(deps());
  const withGuest: LiveRoster = { ...live, members: [...live.members, { id: "guest", type: "external" }] };
  assert.equal(await check("josh@example.com", newGroup, withGuest), false);
  assert.equal(await check("josh@example.com", newGroup, { ...live, members: [] }), false);
  const untyped: LiveRoster = { ...live, members: live.members.map((m) => ({ id: m.id })) };
  assert.equal(await check("josh@example.com", newGroup, untyped), false);
  const notListed: LiveRoster = {
    actorId: "josh@example.com",
    members: [{ id: "regan@example.com", type: "internal" }],
  };
  assert.equal(await check("josh@example.com", newGroup, notListed), false);
  const managed = createIsCurrentSharedScopeMember({
    ...deps(),
    managedGroups: { recognizes: () => true, membership: async () => false, members: async () => [] },
  });
  assert.equal(await managed("josh@example.com", newGroup, live), false);
  assert.equal(await check("josh@example.com", "personal:josh@example.com" as ScopeId, live), false);
  const inactive = createIsCurrentSharedScopeMember({
    ...deps(),
    identity: { classify: () => ({ type: "external" }) },
  });
  assert.equal(await inactive("josh@example.com", newGroup, live), false);
});

test("a failed or missing roster probe fails closed", async () => {
  const boom = createIsCurrentSharedScopeMember(
    deps({
      conversationRosterKnown: async () => {
        throw new Error("store down");
      },
    }),
  );
  assert.equal(await boom("josh@example.com", newGroup, live), false);
  const noProbe = createIsCurrentSharedScopeMember({
    directory: { channelMember: async () => false, groupMember: async () => false },
  });
  assert.equal(await noProbe("josh@example.com", newGroup, live), false);
});

test("a listed room whose roster is not synced yet still counts as unknown", async () => {
  // The store may list a room by id before its member list has been crawled.
  const check = createIsCurrentSharedScopeMember(deps({ conversationRosterKnown: async () => false }));
  assert.equal(await check("josh@example.com", knownGroup, live), true);
  assert.equal(await check("mallory@example.com", knownGroup, live), false, "still only the speaker");
});

test("withLiveRoster forwards the hint only for the turn's own scope", async () => {
  const seen: Array<LiveRoster | undefined> = [];
  const wrapped = withLiveRoster(
    async (_p, _s, hint) => {
      seen.push(hint);
      return false;
    },
    { scopeId: newGroup, roster: live },
  );
  await wrapped("josh@example.com", newGroup);
  await wrapped("josh@example.com", knownGroup);
  assert.deepEqual(seen, [live, undefined]);
  const none = withLiveRoster(undefined, { scopeId: newGroup, roster: live });
  assert.equal(await none("josh@example.com", newGroup), false);
});
