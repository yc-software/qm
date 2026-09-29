import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanReadScope, withLiveTurnMembership } from "../src/resolution/scope-membership.ts";
import type { ScopeId } from "../src/types.ts";

const room = "group:C0NEW" as ScopeId;
const otherRoom = "group:C0OTHER" as ScopeId;
const stored = async (principalId: string, scope: ScopeId) =>
  scope === otherRoom && principalId === "regan@example.com";

test("a verified live turn proves the speaker's membership in its own scope while the store lags", async () => {
  const check = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await check("josh@example.com", room), true);
  assert.equal(await check("JOSH@example.com", room), true);
  assert.equal(await check("regan@example.com", room), false);
});

test("the live turn says nothing about other scopes or unverified turns", async () => {
  const verified = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await verified("josh@example.com", otherRoom), false);
  assert.equal(await verified("regan@example.com", otherRoom), true);
  const unverified = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: false });
  assert.equal(await unverified("josh@example.com", room), false);
  const noStore = withLiveTurnMembership(undefined, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await noStore("josh@example.com", otherRoom), false);
});

for (const kind of ["channel", "group"] as const) {
  test(`${kind} historical projection is used only when current membership is unknown`, async () => {
    const scope: ScopeId = `${kind}:history`;
    let current: boolean | undefined;
    const calls: Array<[string, ScopeId]> = [];
    const directory = {
      channelMember: async () => false,
      groupMember: async () => false,
      channelPrivacy: async () => undefined,
      channelMembership: async () => current,
      groupMembership: async () => current,
    };
    const sessions = {
      participantHasScope: async (principalId: string, candidate: ScopeId) => {
        calls.push([principalId, candidate]);
        return principalId === "owner" && candidate === scope;
      },
    };
    const canRead = createCanReadScope({ directory, sessions });
    assert.equal(await canRead("owner", scope), true);
    assert.equal(await canRead("stranger", scope), false);
    assert.deepEqual(calls, [
      ["owner", scope],
      ["stranger", scope],
    ]);
    current = false;
    assert.equal(await canRead("owner", scope), false);
    current = true;
    assert.equal(await canRead("owner", scope), true);
    assert.equal(calls.length, 2);
    current = undefined;
    sessions.participantHasScope = async () => {
      throw new Error("historical projection unavailable");
    };
    assert.equal(await canRead("owner", scope), false);
    assert.equal(await createCanReadScope({ directory })("owner", scope), false);
  });
}

test("managed group refusal cannot fall back to historical participation", async () => {
  let historicalReads = 0;
  const canRead = createCanReadScope({
    managedGroups: {
      recognizes: () => true,
      membership: async () => false,
      members: async () => [],
    },
    sessions: {
      participantHasScope: async () => {
        historicalReads++;
        return true;
      },
    },
  });
  assert.equal(await canRead("owner", "group:web-project-revoked"), false);
  assert.equal(historicalReads, 0);
});
