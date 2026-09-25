import { test } from "node:test";
import assert from "node:assert/strict";
import { withLiveTurnMembership } from "../src/resolution/scope-membership.ts";
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
