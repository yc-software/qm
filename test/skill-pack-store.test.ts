import test from "node:test";
import assert from "node:assert/strict";
import { createSkillPackStore, type NewSkillPack } from "../src/skills/skill-pack-store.ts";
import { scopeId } from "../src/types.ts";

const base: NewSkillPack = {
  kind: "git",
  url: "https://github.com/example/examples-skills",
  ref: "f94063e9",
  syncMode: "pinned",
  trustTier: "third-party",
  config: { exclude: ["trusted/*"] },
  targetScopeId: scopeId("org", "acme"),
  subset: "all",
  createdBy: "u1",
};

test("create stamps id + createdAt and is retrievable", async () => {
  const store = createSkillPackStore({ now: () => 1000 });
  const s = await store.create(base);
  assert.ok(s.id);
  assert.equal(s.createdAt, 1000);
  assert.equal((await store.get(s.id))!.url, base.url);
  assert.equal((await store.list()).length, 1);
});

test("update merges fields; recordImport stamps lastImport", async () => {
  const store = createSkillPackStore();
  const s = await store.create(base);
  const upd = await store.update(s.id, { ref: "deadbeef" });
  assert.equal(upd.ref, "deadbeef");
  assert.equal(upd.url, base.url);
  await store.recordImport(s.id, { at: 5, commit: "deadbeef", status: "ok", counts: { imported: 155 } });
  assert.deepEqual((await store.get(s.id))!.lastImport, {
    at: 5,
    commit: "deadbeef",
    status: "ok",
    counts: { imported: 155 },
  });
});

test("update throws on an unknown id; remove deletes", async () => {
  const store = createSkillPackStore();
  await assert.rejects(() => store.update("nope", { ref: "x" }));
  const s = await store.create(base);
  await store.remove(s.id);
  assert.equal(await store.get(s.id), null);
});
