import test from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { testSkillStore } from "./support/typed-stores.ts";

const org = scopeId("org", "default-org");
const manifest = { name: "demo", description: "d", requiredCapabilities: [], body: "# Demo" };

test("recordUse sets lastUsedAt without touching version/updatedAt or the signature", async () => {
  const skills = testSkillStore();
  const s = await skills.create({ scopeId: org, manifest, createdBy: "alice" });
  assert.equal(s.lastUsedAt, undefined);
  await skills.recordUse(s.id, 12345);
  const after = (await skills.get(s.id))!;
  assert.equal(after.lastUsedAt, 12345);
  assert.equal(after.version, s.version);
  assert.equal(after.updatedAt, s.updatedAt);
  assert.equal(skills.verify(after), true);
});

test("recordUse on an unknown id is a no-op", async () => {
  const skills = testSkillStore();
  await skills.recordUse("nope");
  assert.equal(await skills.get("nope"), null);
});
