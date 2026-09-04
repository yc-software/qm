import { test } from "node:test";
import assert from "node:assert/strict";
import { createAclStore, type ScopeManagement } from "../src/acl/acl-store.ts";
import { deployRef, encodeRef } from "../src/acl/resource-ref.ts";
import { scopeId, type Grant } from "../src/types.ts";

const CHAN = scopeId("channel", "C1");
const GROUP = scopeId("group", "G1");
const CHAN_MEMBERS = new Set(["alice"]);
const GROUP_MEMBERS = new Set(["bob"]);

const manages: ScopeManagement = async (principalId, scope) => {
  if (scope === CHAN) return CHAN_MEMBERS.has(principalId);
  if (scope === GROUP) return GROUP_MEMBERS.has(principalId);
  return false;
};

const ref = encodeRef(deployRef("d1"));
const carol = scopeId("personal", "carol");
const grant = (over: Partial<Grant>): Grant => ({
  ownerScopeId: CHAN,
  ref,
  granteeScopeId: carol,
  permission: "read",
  grantedBy: "alice",
  ...over,
});

test("a channel member may grant and revoke its artifacts (members manage)", async () => {
  const acl = createAclStore(undefined, { manages });
  await acl.grant(grant({ grantedBy: "alice" }));
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1);
  await acl.revoke(CHAN, ref, carol, "alice");
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 0);
});

test("a non-member cannot grant or revoke a channel artifact", async () => {
  const acl = createAclStore(undefined, { manages });
  await assert.rejects(acl.grant(grant({ grantedBy: "mallory" })), /only a manager/);
  await acl.grant(grant({ grantedBy: "alice" }));
  await assert.rejects(acl.revoke(CHAN, ref, carol, "mallory"), /only a manager/);
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1, "grant survives the rejected revoke");
});

test("a group-DM member may manage its artifacts; a non-member may not", async () => {
  const acl = createAclStore(undefined, { manages });
  await acl.grant(grant({ ownerScopeId: GROUP, grantedBy: "bob" }));
  assert.equal((await acl.grantsFor(GROUP, ref)).length, 1);
  await assert.rejects(acl.grant(grant({ ownerScopeId: GROUP, grantedBy: "alice" })), /only a manager/);
});

test("personal-scope owner authz is unchanged: only the owner manages", async () => {
  const acl = createAclStore(undefined, { manages });
  const owner = scopeId("personal", "U1");
  await assert.rejects(acl.grant(grant({ ownerScopeId: owner, grantedBy: "U2" })), /only a manager/);
  await acl.grant(grant({ ownerScopeId: owner, grantedBy: "U1" }));
  assert.equal((await acl.grantsFor(owner, ref)).length, 1);
});

test("without a membership predicate, channel/group grants pass unguarded (narrow unit slices)", async () => {
  const acl = createAclStore();
  await acl.grant(grant({ grantedBy: "anyone" }));
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1);
});

test("org/team home scopes are not membership-managed: grants pass unguarded as before", async () => {
  const acl = createAclStore(undefined, { manages });
  const org = scopeId("org", "default-org");
  const team = scopeId("team", "eng");
  await acl.grant(grant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.grant(grant({ ownerScopeId: team, grantedBy: "someone" }));
  assert.equal((await acl.grantsFor(org, ref)).length, 1);
  assert.equal((await acl.grantsFor(team, ref)).length, 1);
});

const PUBCHAN = scopeId("channel", "PUB");
const managesWithAuthorDoor: ScopeManagement = async (principalId, scope, authoredBy) => {
  if (scope === CHAN) return CHAN_MEMBERS.has(principalId);
  if (scope === PUBCHAN) return authoredBy === principalId;
  return false;
};

test("a PUBLIC-channel artifact's author may grant when the guard is told the author (authoredBy)", async () => {
  const acl = createAclStore(undefined, { manages: managesWithAuthorDoor });
  await acl.grant(grant({ ownerScopeId: PUBCHAN, grantedBy: "U1" }), "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, ref)).length, 1);
});

test("a non-author on a PUBLIC channel is still denied — the author door does not open for members", async () => {
  const acl = createAclStore(undefined, { manages: managesWithAuthorDoor });
  await assert.rejects(acl.grant(grant({ ownerScopeId: PUBCHAN, grantedBy: "U2" }), "U1"), /only a manager/);
  await assert.rejects(acl.grant(grant({ ownerScopeId: PUBCHAN, grantedBy: "U1" })), /only a manager/);
  assert.equal((await acl.grantsFor(PUBCHAN, ref)).length, 0);
});

test("the author door does NOT weaken a PRIVATE channel — authoredBy can't let a non-member author in", async () => {
  const acl = createAclStore(undefined, { manages: managesWithAuthorDoor });
  await assert.rejects(acl.grant(grant({ ownerScopeId: CHAN, grantedBy: "U1" }), "U1"), /only a manager/);
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 0);
  await acl.grant(grant({ ownerScopeId: CHAN, grantedBy: "alice" }), "U1");
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1);
});

test("revoke honors the author door too: a PUBLIC-channel author may revoke, a non-author may not", async () => {
  const acl = createAclStore(undefined, { manages: managesWithAuthorDoor });
  await acl.grant(grant({ ownerScopeId: PUBCHAN, grantedBy: "U1" }), "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, ref)).length, 1);
  await assert.rejects(acl.revoke(PUBCHAN, ref, carol, "U2", "U1"), /only a manager/);
  assert.equal((await acl.grantsFor(PUBCHAN, ref)).length, 1, "grant survives the rejected revoke");
  await acl.revoke(PUBCHAN, ref, carol, "U1", "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, ref)).length, 0);
});
