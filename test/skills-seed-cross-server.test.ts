import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillStore, type SkillRows } from "../src/skills/skill-store.ts";
import { createPostgresSkillRows } from "../src/skills/postgres-skill-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { installSeedSkills } from "../src/skills/seed.ts";
import { skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

async function withSharedSkills(
  fn: (shared: { rows: SkillRows; lock: () => AdvisoryLock }) => Promise<void>,
): Promise<void> {
  await withTypedTableDb(createPostgresSkillRows, async ({ store, url, tenant }) => {
    const pg = createPgPool(url);
    try {
      await withTenant(tenant, () => fn({ rows: store, lock: () => createPostgresAdvisoryLock(pg) }));
    } finally {
      await pg.close();
    }
  });
}

const slowReads = (rows: SkillRows): SkillRows => ({
  ...rows,
  async inScopes(scopes, name) {
    const found = await rows.inScopes(scopes, name);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return found;
  },
});

test("two servers seeding the same catalog at boot install each skill once", { skip }, () =>
  withSharedSkills(async ({ rows: shared, lock }) => {
    const dir = mkdtempSync(join(tmpdir(), "seed-xsrv-"));
    mkdirSync(join(dir, "hello"));
    writeFileSync(join(dir, "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello.\n---\nSay hello.\n");
    const left = skillStore(slowReads(shared), { signingSecret: "s", advisoryLock: lock() });
    const right = skillStore(slowReads(shared), { signingSecret: "s", advisoryLock: lock() });
    const org = scopeId("org", "default-org");

    const seedModule = "../src/skills/seed.ts";
    type Seed = typeof import("../src/skills/seed.ts");
    const leftServer = (await import(`${seedModule}?server=left`)) as Seed;
    const rightServer = (await import(`${seedModule}?server=right`)) as Seed;
    await Promise.all([
      leftServer.installSeedSkills(left, { dir, scopeId: org }),
      rightServer.installSeedSkills(right, { dir, scopeId: org }),
    ]);

    const rows = (await shared.listAll()).filter((s) => s.manifest.name === "hello");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "published");
  }),
);

test("an admin archive racing another server's changed seed update leaves the skill archived", { skip }, () =>
  withSharedSkills(async ({ rows: shared, lock }) => {
    const dir = mkdtempSync(join(tmpdir(), "seed-archive-xsrv-"));
    const seedWriting = Promise.withResolvers<void>();
    const releaseSeed = Promise.withResolvers<void>();
    const archiveLockEntered = Promise.withResolvers<void>();
    const archiveLock = lock();
    const left = skillStore(
      {
        ...shared,
        async save(skill) {
          if (skill.status === "draft" && skill.manifest.body === "Updated instructions.\n") {
            seedWriting.resolve();
            await releaseSeed.promise;
          }
          await shared.save(skill);
        },
      },
      { signingSecret: "s", advisoryLock: lock() },
    );
    const right = skillStore(shared, {
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

      const rows = await shared.listAll();
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
  }),
);
