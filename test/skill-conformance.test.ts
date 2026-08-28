import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSeedSkill } from "../src/skills/seed.ts";

const SEED_DIR = join(process.cwd(), "skills-seed");

function seedSkillFiles(): string[] {
  if (!existsSync(SEED_DIR)) return [];
  return readdirSync(SEED_DIR)
    .map((entry) => join(SEED_DIR, entry, "SKILL.md"))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

test("every seed SKILL.md parses with a name, description, and body", () => {
  const files = seedSkillFiles();
  assert.ok(files.length > 0, `expected at least one seed SKILL.md under ${SEED_DIR}`);
  for (const path of files) {
    const m = parseSeedSkill(readFileSync(path, "utf8"));
    assert.ok(m.name && m.description && m.body.trim(), `${path} is missing a required field`);
  }
});
