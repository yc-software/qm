import assert from "node:assert/strict";
import test from "node:test";
import type { SkillItem } from "../src/composer.ts";
import { filterSkillGroups, filterSkills, groupSkills, skillEmptyState, statusCounts } from "../src/skill-registry.ts";

function skill(overrides: Partial<SkillItem> = {}): SkillItem {
  return {
    id: "skill-1",
    name: "deploy",
    description: "Ship an application",
    scope: "org",
    source: "native",
    status: "published",
    ...overrides,
  };
}

test("groups same-name active and archived variants without inventing a global winner", () => {
  const groups = groupSkills([
    skill({ id: "archived", scope: "personal", scopeId: "personal:jordan", status: "archived" }),
    skill({ id: "org", scope: "org", scopeId: "org:acme", shadowed: true }),
    skill({ id: "other", name: "browse" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["browse", "deploy"],
  );
  assert.deepEqual(
    groups[1]!.skills.map((row) => row.id),
    ["org", "archived"],
  );
});

test("keeps case-distinct skill names in separate groups", () => {
  const groups = groupSkills([skill({ id: "upper", name: "Deploy" }), skill({ id: "lower", name: "deploy" })]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.name).sort(), ["Deploy", "deploy"]);
  assert.deepEqual(groups.flatMap((group) => group.skills.map((row) => row.id)).sort(), ["lower", "upper"]);
});

test("scope filtering keeps the matching variant and overrides filtering keeps the whole collision group", () => {
  const groups = groupSkills([
    skill({ id: "personal", scope: "personal", shadowed: true }),
    skill({ id: "org", scope: "org" }),
  ]);
  const filtered = filterSkillGroups(groups, { query: "", scope: "org", source: "all", status: "active" });
  assert.deepEqual(
    filtered[0]!.skills.map((row) => row.id),
    ["org"],
  );
  const overrides = filterSkillGroups(groups, { query: "", scope: "all", source: "overrides", status: "active" });
  assert.deepEqual(
    overrides[0]!.skills.map((row) => row.id),
    ["personal", "org"],
  );
});

test("filters by status, scope, source, override, and searchable metadata", () => {
  const skills = [
    skill({ id: "active", scope: "personal", scopeId: "personal:jordan", shadowed: true }),
    skill({
      id: "archived",
      status: "archived",
      source: "pack",
      pack: { packId: "p", commit: "c", upstreamName: "tools" },
    }),
  ];
  assert.deepEqual(
    filterSkills(skills, { query: "jordan", scope: "personal", source: "overrides", status: "active" }).map(
      (row) => row.id,
    ),
    ["active"],
  );
  assert.deepEqual(
    filterSkills(skills, { query: "tools", scope: "all", source: "pack", status: "archived" }).map((row) => row.id),
    ["archived"],
  );
  assert.deepEqual(filterSkills(skills, { query: "missing", scope: "all", source: "all", status: "all" }), []);
});

test("counts active and archived skill variants", () => {
  assert.deepEqual(statusCounts([skill(), skill({ id: "a", status: "archived" }), skill({ id: "b" })]), {
    active: 2,
    archived: 1,
    all: 3,
  });
});

test("empty-state decisions distinguish loading, a filtered miss, and a truly empty catalog", () => {
  assert.equal(skillEmptyState(0, 0, true), "loading");
  assert.equal(skillEmptyState(4, 0, false), "filtered");
  assert.equal(skillEmptyState(0, 0, false), "empty");
  assert.equal(skillEmptyState(4, 2, false), "none");
});
