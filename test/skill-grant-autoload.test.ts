import { test } from "node:test";
import assert from "node:assert/strict";
import { createAclStore } from "../src/acl/acl-store.ts";
import { encodeRef, skillRef, parseRef } from "../src/acl/resource-ref.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { createSkillStore, type SkillManifest, type SkillStore } from "../src/skills/skill-store.ts";
import { scopeId, type Principal, type ScopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const JOSH = scopeId("personal", "josh");
const ERIC = scopeId("personal", "eric");
const P = (id: string, teamIds: string[] = []): Principal => ({ id, type: "internal", teamIds });

const manifest = (name: string): SkillManifest => ({
  name,
  description: "d",
  requiredCapabilities: [],
  body: `# ${name}`,
});

async function publishedSkill(store: SkillStore, scope: ScopeId, name: string) {
  const s = await store.create({ scopeId: scope, manifest: manifest(name), createdBy: "josh" });
  await store.review(s.id, "reviewer", []);
  return store.publish(s.id);
}

test("person-to-person skill grant reaches the grantee's audience", async () => {
  const acl = createAclStore();
  await acl.grant({
    ownerScopeId: JOSH,
    ref: encodeRef(skillRef("s1")),
    granteeScopeId: ERIC,
    permission: "read",
    grantedBy: "josh",
  });

  const inEricsDm = await acl.sharedOfKindForAudience("skill", [P("eric")], ERIC, ORG, principalEntitledToScope);
  assert.deepEqual(
    inEricsDm.map((g) => parseRef(g.ref).id),
    ["s1"],
  );

  const together = await acl.sharedOfKindForAudience(
    "skill",
    [P("eric"), P("josh")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.equal(together.length, 1);

  const mixed = await acl.sharedOfKindForAudience(
    "skill",
    [P("eric"), P("mallory")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(mixed, []);

  const other = await acl.sharedOfKindForAudience(
    "skill",
    [P("alice")],
    scopeId("personal", "alice"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(other, []);
});

test("visibleFor includes granted skills, shadowed by scope-owned skills of the same name", async () => {
  const store = createSkillStore({ signingSecret: "grant-test" });
  const granted = await publishedSkill(store, JOSH, "quickbooks");
  const own = await publishedSkill(store, ERIC, "quickbooks");
  const unique = await publishedSkill(store, JOSH, "reconcile");

  const before = await store.visibleFor([ERIC, ORG]);
  assert.deepEqual(
    before.map((r) => r.skill!.id),
    [own.id],
  );

  const ref = (s: { id: string; scopeId: ReturnType<typeof scopeId> }) => ({ id: s.id, ownerScopeId: s.scopeId });

  const withGrant = await store.visibleFor([ERIC, ORG], [ref(unique)]);
  assert.deepEqual(new Set(withGrant.map((r) => r.skill!.id)), new Set([own.id, unique.id]));

  const collided = await store.visibleFor([ERIC, ORG], [ref(granted), ref(unique)]);
  const quickbooks = collided.filter((r) => r.skill!.manifest.name === "quickbooks");
  assert.equal(quickbooks.length, 1);
  assert.equal(quickbooks[0]!.skill!.id, own.id);
  assert.deepEqual(
    quickbooks[0]!.shadowed.map((s) => s.id),
    [granted.id],
  );

  const draft = await store.create({ scopeId: JOSH, manifest: manifest("draft-skill"), createdBy: "josh" });
  const ignored = await store.visibleFor([ERIC, ORG], [ref(draft), { id: "no-such-id", ownerScopeId: JOSH }]);
  assert.deepEqual(
    ignored.map((r) => r.skill!.id),
    [own.id],
  );
});

test("a grant redundant with scope visibility does not self-shadow", async () => {
  const store = createSkillStore({ signingSecret: "self-shadow-test" });
  const own = await publishedSkill(store, ERIC, "quickbooks");

  const rows = await store.visibleFor([ERIC, ORG], [{ id: own.id, ownerScopeId: ERIC }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.skill!.id, own.id);
  assert.deepEqual(rows[0]!.shadowed, []);
});

test("a grant whose claimed owner scope does not match the skill's home is ignored", async () => {
  const store = createSkillStore({ signingSecret: "forge-test" });
  const victim = await publishedSkill(store, JOSH, "victim-skill");

  const forged = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: ERIC }]);
  assert.deepEqual(forged, []);

  const legit = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: JOSH }]);
  assert.deepEqual(
    legit.map((r) => r.skill!.id),
    [victim.id],
  );
});
