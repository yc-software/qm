import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIsCurrentSharedScopeMember,
  withLiveTurnMembership,
  type ScopeMembershipDeps,
} from "../src/resolution/scope-membership.ts";
import type { ScopeId } from "../src/types.ts";

const newGroup = "group:C0NEW" as ScopeId;
const knownGroup = "group:C0KNOWN" as ScopeId;

function deps(overrides: Partial<NonNullable<ScopeMembershipDeps["directory"]>> = {}): ScopeMembershipDeps {
  return {
    directory: {
      channelMember: async () => false,
      groupMember: async (groupId, principalId) => groupId === "C0KNOWN" && principalId === "regan@example.com",
      conversationRosterKnown: async (_kind, id) => id === "C0KNOWN",
      ...overrides,
    },
  };
}

test("a verified live speaker counts as a member of a room the store has not synced yet", async () => {
  const check = createIsCurrentSharedScopeMember(deps());
  assert.equal(await check("josh@example.com", newGroup), false);
  assert.equal(await check("josh@example.com", newGroup, true), true);
});

test("a stored roster always wins, including one that excludes the speaker", async () => {
  const check = createIsCurrentSharedScopeMember(deps());
  assert.equal(await check("josh@example.com", knownGroup, true), false);
  assert.equal(await check("regan@example.com", knownGroup), true);
});

test("managed groups, stores without the probe, and failing probes never use the fallback", async () => {
  const managed = createIsCurrentSharedScopeMember({
    ...deps(),
    managedGroups: { recognizes: () => true, membership: async () => false, members: async () => [] },
  });
  assert.equal(await managed("josh@example.com", newGroup, true), false);
  const legacy = createIsCurrentSharedScopeMember(deps({ conversationRosterKnown: undefined }));
  assert.equal(await legacy("josh@example.com", newGroup, true), false);
  const failing = createIsCurrentSharedScopeMember(
    deps({
      conversationRosterKnown: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal(await failing("josh@example.com", newGroup, true), false);
});

test("withLiveTurnMembership marks only the speaker, only for the turn's own scope", async () => {
  const seen: Array<[string, ScopeId, boolean | undefined]> = [];
  const stored = async (principalId: string, scope: ScopeId, live?: boolean) => {
    seen.push([principalId, scope, live]);
    return false;
  };
  const check = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: newGroup, verified: true });
  await check("JOSH@example.com", newGroup);
  await check("regan@example.com", newGroup);
  await check("josh@example.com", knownGroup);
  const unverified = withLiveTurnMembership(stored, {
    actorId: "josh@example.com",
    scopeId: newGroup,
    verified: false,
  });
  await unverified("josh@example.com", newGroup);
  assert.deepEqual(
    seen.map(([, , live]) => live),
    [true, false, false, false],
  );
  const noStore = withLiveTurnMembership(undefined, { actorId: "josh@example.com", scopeId: newGroup, verified: true });
  assert.equal(await noStore("josh@example.com", newGroup), false);
});
