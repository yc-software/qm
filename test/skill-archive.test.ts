import test from "node:test";
import assert from "node:assert/strict";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "default-org");
const manifest = { name: "demo", description: "d", requiredCapabilities: [], body: "# Demo" };

async function published() {
  const skills = createSkillStore();
  const s = await skills.create({ scopeId: org, manifest, createdBy: "pack:src1" });
  await skills.review(s.id, "system:pack-reviewer", []);
  await skills.publish(s.id);
  return { skills, id: s.id };
}

test("archive stops a skill resolving but keeps the record", async () => {
  const { skills, id } = await published();
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
  assert.equal((await skills.visibleFor([org])).length, 1);

  const archived = await skills.archive(id);
  assert.equal(archived.status, "archived");
  assert.equal((await skills.resolve("demo", [org])).skill, null);
  assert.equal((await skills.visibleFor([org])).length, 0);
  assert.equal((await skills.get(id))!.status, "archived");
});

test("archive is idempotent", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  const again = await skills.archive(id);
  assert.equal(again.status, "archived");
});

test("an archived skill can be re-published (resurrection on re-import)", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  await skills.publish(id);
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
});

test("create carries pack provenance, kept out of the signature", async () => {
  const skills = createSkillStore();
  const s = await skills.create({
    scopeId: org,
    manifest,
    createdBy: "pack:src1",
    pack: { packId: "src1", commit: "abc123", upstreamName: "demo" },
  });
  assert.deepEqual(s.pack, { packId: "src1", commit: "abc123", upstreamName: "demo" });
  assert.ok(skills.verify(s));
});
