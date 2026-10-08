import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryAdvisoryLock,
  createPostgresAdvisoryLock,
  type AdvisoryLock,
} from "../src/persistence/advisory-lock.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const factory = URL ? createPostgresMapFactory(URL) : null;
after(async () => {
  await factory?.pool.close();
});

const shared = async (): Promise<{ backing: DurableMap<Skill>; lock: () => AdvisoryLock }> => {
  if (!factory) {
    const lock = createMemoryAdvisoryLock();
    return { backing: createMemoryMap<Skill>(), lock: () => lock };
  }
  const table = `xsrv_skills_${process.pid}`;
  await factory.pool.query(`DROP TABLE IF EXISTS ${table}`);
  return { backing: factory.map<Skill>(table), lock: () => createPostgresAdvisoryLock(factory.pool) };
};

const slowReads = (map: DurableMap<Skill>): DurableMap<Skill> => ({
  ...map,
  async all() {
    const rows = await map.all();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return rows;
  },
});

test("two servers seeding the same catalog at boot install each skill once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-xsrv-"));
  mkdirSync(join(dir, "hello"));
  writeFileSync(join(dir, "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello.\n---\nSay hello.\n");
  const { backing, lock } = await shared();
  const left = createSkillStore({ backing: slowReads(backing), signingSecret: "s", advisoryLock: lock() });
  const right = createSkillStore({ backing: slowReads(backing), signingSecret: "s", advisoryLock: lock() });
  const org = scopeId("org", "default-org");

  const seedModule = "../src/skills/seed.ts";
  type Seed = typeof import("../src/skills/seed.ts");
  const leftServer = (await import(`${seedModule}?server=left`)) as Seed;
  const rightServer = (await import(`${seedModule}?server=right`)) as Seed;
  await Promise.all([
    leftServer.installSeedSkills(left, { dir, scopeId: org }),
    rightServer.installSeedSkills(right, { dir, scopeId: org }),
  ]);

  const rows = (await backing.all()).filter((s) => s.manifest.name === "hello");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "published");
});
