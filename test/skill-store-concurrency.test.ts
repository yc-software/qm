import test from "node:test";
import assert from "node:assert/strict";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function serializedMap(): DurableMap<Skill> {
  const inner = createMemoryMap<Skill>();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ...inner,
    async get(id) {
      const value = await inner.get(id);
      await tick();
      return value ? structuredClone(value) : null;
    },
    async put(id, value) {
      await tick();
      await inner.put(id, structuredClone(value));
    },
    update(id, fn) {
      return inner.update!(id, (value) => structuredClone(fn(structuredClone(value))));
    },
  };
}

const org = scopeId("org", "default-org");
const personal = scopeId("personal", "U1");
const manifest = { name: "demo", description: "d", requiredCapabilities: [], body: "# Demo" };

test("an edit racing a review on a row-serialized backing is not silently dropped", async () => {
  const skills = createSkillStore({ backing: serializedMap() });
  const s = await skills.create({ scopeId: org, manifest, createdBy: "U1" });
  await Promise.all([skills.update(s.id, { ...manifest, body: "# Demo v2" }), skills.review(s.id, "U2", [])]);
  const after = (await skills.get(s.id))!;
  assert.equal(after.manifest.body, "# Demo v2", "the edit survives");
  assert.ok(skills.verify(after));
});

test("concurrent edits each bump the version", async () => {
  const skills = createSkillStore({ backing: serializedMap() });
  const s = await skills.create({ scopeId: personal, manifest, createdBy: "U1" });
  await Promise.all(Array.from({ length: 5 }, (_, i) => skills.update(s.id, { ...manifest, body: `# v${i}` })));
  assert.equal((await skills.get(s.id))!.version, s.version + 5);
});
