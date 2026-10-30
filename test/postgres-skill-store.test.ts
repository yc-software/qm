import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeploymentLayerStore } from "../src/deployment/deployment-layer-store.ts";
import { emptyDeploymentLayer } from "../src/deployment/load-layer.ts";
import type { StoredDeploymentLayer } from "../src/deployment/deployment-layer-store.ts";
import { createPostgresSkillStore } from "../src/skills/postgres-skill-store.ts";
import type { SkillManifest, SkillStore } from "../src/skills/skill-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const ORG = scopeId("org", "acme");
const ALICE = scopeId("personal", "alice");
const TEAM = scopeId("team", "t1");
const make = (url: string) => createPostgresSkillStore(url, { signingSecret: "pg-test" });

const manifest = (name: string, extra: Partial<SkillManifest> = {}): SkillManifest => ({
  name,
  description: `${name} helper`,
  requiredCapabilities: [],
  body: `# ${name}`,
  ...extra,
});

async function published(
  store: SkillStore,
  scope: ReturnType<typeof scopeId>,
  m: SkillManifest,
  pack?: { packId: string; commit: string; upstreamName: string },
) {
  const created = await store.create({ scopeId: scope, manifest: m, createdBy: "alice", ...(pack ? { pack } : {}) });
  await store.review(created.id, "reviewer", m.requiredCapabilities);
  return store.publish(created.id);
}

test("skill queries hit only the rows each caller needs", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      const files = [{ path: "lib/run.sh", content: "echo hi", executable: true }];
      const orgDigest = await published(store, ORG, manifest("digest", { files, requiredCapabilities: ["net"] }));
      const mine = await published(store, ALICE, manifest("digest"));
      const packed = await published(store, TEAM, manifest("lint", { body: "privatebody" }), {
        packId: "p1",
        commit: "c1",
        upstreamName: "lint",
      });
      const draft = await store.create({ scopeId: ALICE, manifest: manifest("draft-only"), createdBy: "alice" });
      const archived = await published(store, TEAM, manifest("retired"));
      await store.archive(archived.id);

      assert.deepEqual(await store.get(orgDigest.id), orgDigest);
      assert.equal(store.verify((await store.get(orgDigest.id))!), true);
      assert.deepEqual((await store.inScopes([ALICE])).map((s) => s.id).sort(), [mine.id, draft.id].sort());
      assert.deepEqual(
        (await store.inScopes([ALICE, ORG], "digest")).map((s) => s.id).sort(),
        [mine.id, orgDigest.id].sort(),
      );
      assert.deepEqual(
        (await store.publishedNamed(["digest", "draft-only", "retired"])).map((s) => s.id).sort(),
        [mine.id, orgDigest.id].sort(),
      );
      assert.deepEqual(
        (await store.fromPacks(["p1"])).map((s) => s.pack),
        [{ packId: "p1", commit: "c1", upstreamName: "lint" }],
      );
      assert.deepEqual(await store.activePackIds(), ["p1"]);
      assert.deepEqual(
        (await store.archivedFor([TEAM], "nobody")).map((s) => s.id),
        [archived.id],
      );
      assert.deepEqual(
        (await store.archivedFor([], "alice")).map((s) => s.id),
        [archived.id],
      );
      assert.deepEqual(
        (await store.search("lint help", 10)).map((s) => s.id),
        [packed.id],
      );
      assert.deepEqual(await store.search("privatebody", 10), []);
      assert.equal((await store.listAll()).length, 5);

      const resolved = await store.resolve("digest", [ALICE, ORG]);
      assert.equal(resolved.skill?.id, mine.id);
      assert.deepEqual(
        resolved.shadowed.map((s) => s.id),
        [orgDigest.id],
      );

      await store.recordUse(mine.id, 42);
      assert.equal((await store.get(mine.id))?.lastUsedAt, 42);
      const promoted = await store.promote(mine.id, ORG);
      assert.equal((await store.promote(mine.id, ORG)).id, promoted.id);
      await store.delete(draft.id);
      assert.equal(await store.get(draft.id), null);
    });
  });
});

test("a skill persists and verifies across store instances with a stable secret", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, url, tenant }) => {
    const restarted = make(url);
    try {
      await withTenant(tenant, async () => {
        const skill = await published(store, ALICE, manifest("digest"));
        const got = await restarted.get(skill.id);
        assert.deepEqual(got, skill);
        assert.equal(restarted.verify(got!), true);
      });
    } finally {
      await restarted.close?.();
    }
  });
});

test("skills are isolated per tenant and the same scope and name coexist", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, tenant, otherTenant }) => {
    const mine = await withTenant(tenant, () => published(store, ORG, manifest("digest")));
    const theirs = await withTenant(otherTenant, () => published(store, ORG, manifest("digest")));
    await withTenant(otherTenant, async () => {
      assert.equal(await store.get(mine.id), null);
      assert.deepEqual(
        (await store.listAll()).map((s) => s.id),
        [theirs.id],
      );
      assert.deepEqual(
        (await store.publishedNamed(["digest"])).map((s) => s.id),
        [theirs.id],
      );
      assert.deepEqual(await store.search("digest", 10).then((rows) => rows.map((s) => s.id)), [theirs.id]);
      await store.delete(mine.id);
      await store.recordUse(mine.id, 7);
    });
    await withTenant(tenant, async () => {
      const kept = await store.get(mine.id);
      assert.equal(kept?.status, "published");
      assert.equal(kept?.lastUsedAt, undefined);
      assert.deepEqual((await store.resolve("digest", [ORG])).skill?.id, mine.id);
    });
  });
});

test("the conversion backfills skills into the instance tenant and drops the old table", { skip }, async () => {
  const legacy = {
    id: "s1",
    scopeId: ORG,
    manifest: {
      name: "digest",
      description: "makes a digest",
      requiredCapabilities: ["net"],
      body: "# digest",
      files: [{ path: "a.sh", content: "x", executable: true }],
    },
    signature: "sig",
    status: "published",
    createdBy: "pack:p1",
    version: 3,
    grantedCapabilities: ["net"],
    approvals: ["reviewer"],
    createdAt: 10,
    updatedAt: 20,
    lastUsedAt: 30,
    pack: { packId: "p1", commit: "c1", upstreamName: "digest-up" },
  };
  await withTypedTableDb(
    make,
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.get("s1")), legacy);
      assert.deepEqual(await withTenant(tenant, () => store.get("s2")), {
        id: "s2",
        scopeId: ALICE,
        manifest: { name: "bare", description: "", requiredCapabilities: [], body: "" },
        signature: "",
        status: "draft",
        createdBy: "",
        version: 1,
        grantedCapabilities: [],
        approvals: [],
      });
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, name, required_capabilities, files IS NULL AS no_files,
                to_regclass('skills_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'skills') AS versions
           FROM skills ORDER BY id`,
      );
      assert.deepEqual(rows, [
        {
          tenant,
          id: "s1",
          name: "digest",
          required_capabilities: ["net"],
          no_files: false,
          dropped: true,
          versions: 0,
        },
        { tenant, id: "s2", name: "bare", required_capabilities: [], no_files: true, dropped: true, versions: 0 },
      ]);
    },
    (admin) =>
      seedKeyValueTable(admin, "skills", {
        s1: legacy,
        s2: { id: "s2", scopeId: ALICE, manifest: { name: "bare" }, status: "draft" },
        broken: { id: "broken", scopeId: ORG, manifest: { name: "x" }, status: "bogus" },
        nameless: { id: "nameless", scopeId: ORG, manifest: {}, status: "draft" },
        badpack: { id: "badpack", scopeId: ORG, manifest: { name: "y" }, status: "draft", pack: { packId: "p" } },
      }),
  );
});

test(
  "row security alone hides other tenants' skills from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(make, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => published(store, ORG, manifest("digest")));
      const app = createPgPool(url);
      try {
        const names = (bound: string) => withTenant(bound, () => app.q(`SELECT name FROM skills`));
        assert.deepEqual(await names(tenant), [{ name: "digest" }]);
        assert.deepEqual(await names(otherTenant), []);
        await assert.rejects(app.q(`SELECT name FROM skills`), /No tenant is bound/);
        await assert.rejects(store.listAll(), /No tenant is bound/);
      } finally {
        await app.close();
      }
    });
  },
);

async function insertRaw(
  admin: { query(sql: string, params: unknown[]): Promise<unknown> },
  tenant: string,
  name: string,
  status = "published",
) {
  await admin.query(
    `INSERT INTO skills(tenant_id, id, scope_id, name, description, required_capabilities, body, signature, status,
                        created_by, version, granted_capabilities, approvals)
     VALUES ($1, 'legacy', $2, $3, 'legacy', '{}', 'legacy', 'legacy', $4, 'legacy-import', 1, '{}', '{}')`,
    [tenant, ORG, name, status],
  );
}

test("legacy unsafe skill names never reach materialization", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, admin, tenant }) => {
    await insertRaw(admin, tenant, "foo/bar", "reviewed");
    await withTenant(tenant, async () => {
      await assert.rejects(() => store.publish("legacy"), /skill name must/);
      assert.deepEqual(await store.visibleFor([ORG]), []);
    });
  });
});

test(
  "a legacy published skill with an unsafe name is quarantined without blocking layer replacement",
  { skip },
  async () => {
    await withTypedTableDb(make, async ({ store, admin, tenant }) => {
      await insertRaw(admin, tenant, "My Skill");
      await withTenant(tenant, async () => {
        const layer = createDeploymentLayerStore({
          ...singleProcessDeps(),
          backing: createMemoryMap<StoredDeploymentLayer>(),
          runtime: emptyDeploymentLayer(),
          skills: store,
          scopeId: ORG,
        });
        await layer.put({ contract: 1, tools: [], skills: [] }, "test");
        assert.deepEqual(await store.visibleFor([ORG]), []);
        assert.equal((await store.get("legacy"))?.status, "published");
      });
    });
  },
);
