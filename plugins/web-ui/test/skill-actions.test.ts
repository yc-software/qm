import { test } from "node:test";
import assert from "node:assert/strict";
import { skillActions } from "../src/skill-actions.ts";

interface SkillRow {
  id?: string;
  name: string;
  description: string;
  scope: string;
  editable?: boolean;
}

function skill(over: Partial<SkillRow>): SkillRow {
  return { id: "s1", name: "make-digest", description: "d", scope: "personal", ...over };
}

test("owned personal skills get both edit and delete affordances", () => {
  assert.deepEqual(skillActions(skill({ editable: true })), { edit: true, delete: true });
});

test("a skill the user doesn't own (no editable flag) gets neither affordance", () => {
  assert.deepEqual(skillActions(skill({ scope: "org", editable: false })), { edit: false, delete: false });
  assert.deepEqual(skillActions(skill({ scope: "org" })), { edit: false, delete: false });
});

test("an editable skill with no id offers nothing (can't address the DELETE/PUT route)", () => {
  assert.deepEqual(skillActions(skill({ id: undefined, editable: true })), { edit: false, delete: false });
});
