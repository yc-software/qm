import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { scopeId } from "../src/types.ts";
import { installSeedSkills } from "../src/skills/seed.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";

const URL = process.env.DATABASE_URL;
const factory = URL ? createPostgresMapFactory(URL) : null;
let tableSequence = 0;
after(async () => {
  await factory?.pool.close();
});

const shared = async (): Promise<{ backing: DurableMap<Skill>; lock: () => AdvisoryLock }> => {
  if (!factory) {
    const lock = testAdvisoryLock();
    return { backing: testMap<Skill>(), lock: () => lock };
  }
  const table = `xsrv_skills_${process.pid}_${++tableSequence}`;
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

test("an admin archive racing another server's changed seed update leaves the skill archived", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-archive-xsrv-"));
  const { backing, lock } = await shared();
  const copied: DurableMap<Skill> = {
    ...backing,
    get: async (id) => structuredClone(await backing.get(id)),
    all: async () => structuredClone(await backing.all()),
    put: (id, skill) => backing.put(id, structuredClone(skill)),
  };
  const seedWriting = Promise.withResolvers<void>();
  const releaseSeed = Promise.withResolvers<void>();
  const archiveLockEntered = Promise.withResolvers<void>();
  const archiveLock = lock();
  const left = createSkillStore({
    backing: {
      ...copied,
      async put(id, skill) {
        if (skill.status === "draft" && skill.manifest.body === "Updated instructions.\n") {
          seedWriting.resolve();
          await releaseSeed.promise;
        }
        await copied.put(id, skill);
      },
    },
    signingSecret: "s",
    advisoryLock: lock(),
  });
  const right = createSkillStore({
    backing: copied,
    signingSecret: "s",
    advisoryLock: {
      ...archiveLock,
      withLock(key, fn) {
        archiveLockEntered.resolve();
        return archiveLock.withLock(key, fn);
      },
    },
  });
  const org = scopeId("org", "default-org");
  const options = { dir, scopeId: org, respectArchived: true };
  const pending: Promise<unknown>[] = [];
  try {
    mkdirSync(join(dir, "hello"));
    const path = join(dir, "hello", "SKILL.md");
    writeFileSync(path, "---\nname: hello\ndescription: Say hello.\n---\nOriginal instructions.\n");
    await installSeedSkills(left, options);
    const original = (await right.resolve("hello", [org])).skill!;
    assert.ok(original);
    writeFileSync(path, "---\nname: hello\ndescription: Say hello.\n---\nUpdated instructions.\n");

    const seeding = installSeedSkills(left, options);
    pending.push(seeding);
    await Promise.race([
      seedWriting.promise,
      seeding.then(() => assert.fail("the changed seed did not reach the write barrier")),
    ]);
    const archiving = right.archive(original.id);
    pending.push(archiving);
    await Promise.race([archiving, archiveLockEntered.promise]);
    releaseSeed.resolve();
    await Promise.all([seeding, archiving]);

    const rows = await backing.all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, original.id);
    assert.equal(rows[0]!.status, "archived");
    assert.equal(rows[0]!.manifest.body, "Updated instructions.\n");
    assert.equal(rows[0]!.version, original.version + 1);
    assert.equal((await left.resolve("hello", [org])).skill, null);
    assert.equal((await right.resolve("hello", [org])).skill, null);
  } finally {
    releaseSeed.resolve();
    await Promise.allSettled(pending);
    rmSync(dir, { recursive: true, force: true });
  }
});
