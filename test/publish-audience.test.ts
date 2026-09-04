import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPublishAudience } from "../src/resolution/publish-audience.ts";
import { scopeId, type Principal } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const internal = (id: string): Principal => ({ id, type: "internal" });
const guest = (id: string): Principal => ({ id, type: "guest" });

test("DM → owner-only", () => {
  const a = defaultPublishAudience({ kind: "dm", orgScopeId: ORG, ownerId: "U1" });
  assert.equal(a.kind, "owner");
  assert.deepEqual(a.grantees, []);
});

test("group / mpim → owner-only, never org (D4)", () => {
  assert.equal(defaultPublishAudience({ kind: "group", orgScopeId: ORG, ownerId: "U1" }).kind, "owner");
  const a = defaultPublishAudience({ kind: "channel", isMpim: true, isPrivate: false, orgScopeId: ORG, ownerId: "U1" });
  assert.equal(a.kind, "owner");
});

test("public channel (is_channel && !is_private) → one org read grant", () => {
  const a = defaultPublishAudience({ kind: "channel", isPrivate: false, orgScopeId: ORG, ownerId: "U1" });
  assert.equal(a.kind, "org");
  assert.deepEqual(a.grantees, [ORG]);
});

test("absent public-private signal → never org, and FROZEN (incomplete) — a flaky info call can't revoke reach", () => {
  const off = defaultPublishAudience({ kind: "channel", orgScopeId: ORG, ownerId: "U1" });
  assert.equal(off.kind, "owner");
  assert.notEqual(off.kind, "org");
  assert.equal(off.incomplete, true);
  const on = defaultPublishAudience({
    kind: "channel",
    members: [internal("U1"), internal("U2")],
    orgScopeId: ORG,
    ownerId: "U1",
  });
  assert.equal(on.kind, "owner");
  assert.notEqual(on.kind, "org");
  assert.equal(on.incomplete, true);
});

test("private channel → personal grant per internal member ≠ owner; owner excluded", () => {
  const a = defaultPublishAudience({
    kind: "channel",
    isPrivate: true,
    members: [internal("U1"), internal("U2")],
    orgScopeId: ORG,
    ownerId: "U1",
  });
  assert.equal(a.kind, "members");
  assert.deepEqual(a.grantees, [scopeId("personal", "U2")]);
});

test("private channel grants all other internal members", () => {
  const a = defaultPublishAudience({
    kind: "channel",
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
    orgScopeId: ORG,
    ownerId: "U1",
  });
  assert.equal(a.kind, "members");
  assert.deepEqual(a.grantees.sort(), [scopeId("personal", "U2"), scopeId("personal", "U3")].sort());
  assert.equal(a.memberCount, 2);
});

test("private channel: externals/guests excluded from member grants (defense-in-depth)", () => {
  const a = defaultPublishAudience({
    kind: "channel",
    isPrivate: true,
    members: [internal("U1"), internal("U2"), guest("G1")],
    orgScopeId: ORG,
    ownerId: "U1",
  });
  assert.deepEqual(a.grantees, [scopeId("personal", "U2")]);
});

test("private channel, members undefined → owner-only AND flagged incomplete (freeze)", () => {
  const a = defaultPublishAudience({ kind: "channel", isPrivate: true, orgScopeId: ORG, ownerId: "U1" });
  assert.equal(a.kind, "owner");
  assert.equal(a.incomplete, true);
});

test("private channel, only the owner is a member → authoritative owner-only", () => {
  const a = defaultPublishAudience({
    kind: "channel",
    isPrivate: true,
    members: [internal("U1")],
    orgScopeId: ORG,
    ownerId: "U1",
  });
  assert.equal(a.kind, "owner");
  assert.equal(a.incomplete, undefined);
  assert.deepEqual(a.grantees, []);
});

test("KNOWN-private without member enumeration is frozen — a missing roster can't revoke reach", () => {
  const a = defaultPublishAudience({ kind: "channel", isPrivate: true, orgScopeId: ORG, ownerId: "U1" });
  assert.equal(a.kind, "owner");
  assert.equal(a.incomplete, true);
});
