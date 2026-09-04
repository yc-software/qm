import { test } from "node:test";
import assert from "node:assert/strict";
import { createAclStore } from "../src/acl/acl-store.ts";
import { cronRef, deployRef, encodeRef, parseRef, serviceCredRef, skillRef } from "../src/acl/resource-ref.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { scopeId, type Principal } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const P = (id: string, teamIds: string[] = []): Principal => ({ id, type: "internal", teamIds });

function aclWith(grantees: string[]) {
  const acl = createAclStore();
  return Promise.all(
    grantees.map((g) =>
      acl.grant({
        ownerScopeId: ORG,
        ref: "service-cred:x",
        granteeScopeId: g,
        permission: "read",
        grantedBy: "admin",
      }),
    ),
  ).then(() => acl);
}

const slugs = (grants: { ref: string }[]) => grants.map((g) => g.ref.slice("service-cred:".length));

test("org-wide grant is usable by any audience (DM and channel)", async () => {
  const acl = await aclWith([ORG]);
  const dm = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(dm), ["x"]);
  const channel = await acl.grantsOfKind(
    "service-cred",
    [P("U1"), P("U2"), P("U3")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(channel), ["x"]);
});

test("personal grant: usable in the grantee's DM, FAILS CLOSED in a mixed channel", async () => {
  const acl = await aclWith([scopeId("personal", "bob")]);
  const bobDm = await acl.grantsOfKind(
    "service-cred",
    [P("bob")],
    scopeId("personal", "bob"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(bobDm), ["x"]);
  const mixed = await acl.grantsOfKind(
    "service-cred",
    [P("bob"), P("alice")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(mixed), []);
  const aliceDm = await acl.grantsOfKind(
    "service-cred",
    [P("alice")],
    scopeId("personal", "alice"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(aliceDm), []);
});

test("team grant: usable when every member is on the team, fails closed otherwise", async () => {
  const acl = await aclWith([scopeId("team", "eng")]);
  const allEng = await acl.grantsOfKind(
    "service-cred",
    [P("U1", ["eng"]), P("U2", ["eng"])],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(allEng), ["x"]);
  const oneOutsider = await acl.grantsOfKind(
    "service-cred",
    [P("U1", ["eng"]), P("U2", ["sales"])],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(oneOutsider), []);
});

test("empty audience is entitled to nothing (fail closed)", async () => {
  const acl = await aclWith([ORG]);
  assert.deepEqual(
    await acl.grantsOfKind("service-cred", [], scopeId("personal", "U1"), ORG, principalEntitledToScope),
    [],
  );
});

test("a service-cred grant owned by a NON-org scope is ignored (anti self-grant via the open /v1/grants route)", async () => {
  const acl = createAclStore();
  await acl.grant({
    ownerScopeId: scopeId("personal", "attacker"),
    ref: "service-cred:foo",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "attacker",
  });
  const sneaky = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(sneaky), []);
  await acl.grant({
    ownerScopeId: ORG,
    ref: "service-cred:foo",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const legit = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(legit), ["foo"]);
});

test("the prefix filters: a deployment grant is never returned for the service-cred prefix", async () => {
  const acl = createAclStore();
  await acl.grant({
    ownerScopeId: ORG,
    ref: "deployment:d1",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: "service-cred:x",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const got = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(got), ["x"]);
});

test("file handles exclude non-file grants — a skill/cron/deploy grant never becomes a bogus shared/ file", async () => {
  const acl = createAclStore();
  const grantee = scopeId("channel", "C");
  await acl.grant({
    ownerScopeId: ORG,
    ref: "artifacts/F1/doc.md",
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "admin",
  });
  for (const r of [skillRef("s1"), cronRef("c1"), deployRef("d1"), serviceCredRef("x")]) {
    await acl.grant({
      ownerScopeId: ORG,
      ref: encodeRef(r),
      granteeScopeId: grantee,
      permission: "read",
      grantedBy: "admin",
    });
  }
  const handles = await acl.handlesFor([grantee]);
  assert.deepEqual(
    handles.map((h) => h.ownerPath),
    ["artifacts/F1/doc.md"],
    "only the file grant materializes as a handle",
  );
  const audienceHandles = await acl.handlesForAudience([P("U1")], grantee, ORG, principalEntitledToScope);
  assert.deepEqual(
    audienceHandles.map((h) => h.ownerPath),
    ["artifacts/F1/doc.md"],
    "audience handles exclude skill/cron/deploy/service-cred grants",
  );
});

test("grantsOfKind selects by kind across all artifact families (one store, four kinds)", async () => {
  const acl = createAclStore();
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(skillRef("s1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(deployRef("d1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(cronRef("c1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(serviceCredRef("x")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const kinds = ["skill", "deploy", "cron", "service-cred"] as const;
  for (const kind of kinds) {
    const got = await acl.grantsOfKind(kind, [P("U1")], scopeId("personal", "U1"), ORG, principalEntitledToScope);
    assert.deepEqual(
      got.map((g) => parseRef(g.ref).kind),
      [kind],
      `only ${kind} grants come back for kind=${kind}`,
    );
  }
});
