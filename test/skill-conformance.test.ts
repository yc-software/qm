import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSeedSkill } from "../src/skills/seed.ts";

const SEED_DIR = join(process.cwd(), "skills-seed");

test("admin and cloud skills distinguish system administration from resource ownership", () => {
  for (const name of ["admin", "cloud-cli"]) {
    const { body } = parseSeedSkill(readFileSync(join(SEED_DIR, name, "SKILL.md"), "utf8"));
    assert.match(body, /including resources owned by other users/);
    assert.match(body, /credential grants, provider permissions, explicit restrictions, and mutation approvals/);
    assert.match(body, /not impersonation or circumvention/);
  }
});
