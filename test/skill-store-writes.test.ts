import test from "node:test";
import assert from "node:assert/strict";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const channel = scopeId("channel", "C1");
const manifest = { name: "digest", description: "d", requiredCapabilities: [], body: "# v1" };

test(
  "an edit racing a review on durable storage is never overwritten",
  { skip: !URL && "requires Postgres" },
  async () => {
    const pg = createPgPool(URL!);
    const table = `skill_writes_${process.pid}`;
    try {
      const skills = createSkillStore({ backing: createPostgresMap<Skill>(pg, table) });
      const s = await skills.create({ scopeId: channel, manifest, createdBy: "U1" });
      for (let round = 2; round < 12; round++) {
        const body = `# v${round}`;
        await Promise.all([skills.update(s.id, { ...manifest, body }), skills.review(s.id, "U2", [])]);
        assert.equal((await skills.get(s.id))?.manifest.body, body);
      }
    } finally {
      await pg.query(`DROP TABLE IF EXISTS ${table}`);
      await pg.close();
    }
  },
);

test("an edit based on a version that was archived or superseded is refused", async () => {
  const skills = createSkillStore();
  const s = await skills.create({ scopeId: channel, manifest, createdBy: "U1" });
  const opened = s.version;
  const newer = (await skills.update(s.id, { ...manifest, body: "# newer" }, opened)).version;
  await assert.rejects(skills.update(s.id, { ...manifest, body: "# stale" }, opened), /changed since it was read/);
  await skills.archive(s.id);
  await assert.rejects(skills.update(s.id, { ...manifest, body: "# revived" }, newer), /changed/);
  assert.equal((await skills.get(s.id))?.status, "archived");
  assert.equal((await skills.get(s.id))?.manifest.body, "# newer");
});

test("moving a skill into a scope that already has a live skill of that name is refused", async () => {
  const skills = createSkillStore();
  const home = scopeId("personal", "U1");
  const resident = await skills.create({ scopeId: channel, manifest, createdBy: "U2" });
  const mine = await skills.create({ scopeId: home, manifest, createdBy: "U1" });
  await assert.rejects(skills.move(mine.id, channel), /already has a skill named "digest"/);
  assert.equal((await skills.get(mine.id))?.scopeId, home);
  await skills.archive(resident.id);
  assert.equal((await skills.move(mine.id, channel)).scopeId, channel);
});
