import assert from "node:assert/strict";
import test from "node:test";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresProjectStore, projectGroupRef } from "../src/projects/project-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
let ids = 0;
const make = (url: string) =>
  createPostgresProjectStore(url, {
    advisoryLock: createNoopAdvisoryLock(),
    id: () => `p${++ids}`,
    isActiveMember: (principalId) => principalId !== "gone",
  });

test("projects persist rosters, Slack links and channel members through typed columns", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, url, tenant }) => {
    await withTenant(tenant, async () => {
      const project = await store.create({ name: "  Launch   plan ", ownerId: "alice" });
      const other = await store.create({ name: "Other", ownerId: "carol" });
      assert.equal(project.name, "Launch plan");
      assert.equal((await store.addMember(project.id, "alice", "bob")).status, "ok");
      assert.equal((await store.addMember(project.id, "alice", "alice")).status, "invalid_member");
      assert.equal((await store.removeMember(project.id, "bob", "alice")).status, "forbidden");
      assert.equal((await store.rename(project.id, "alice", "Launch")).status, "ok");
      const linked = await store.setSlackChannel(project.id, "bob", { channelId: "C1", channelName: "launch" });
      assert.equal(linked.status, "ok");
      assert.equal((await store.syncChannelMembers(project.id, ["dave", "erin", "dave"])).status, "ok");
      assert.equal((await store.syncChannelMembers(other.id, ["x"])).status, "forbidden");

      const restarted = make(url);
      try {
        const got = await restarted.get(project.id);
        assert.equal(got?.name, "Launch");
        assert.deepEqual(got?.memberIds, ["alice", "bob"]);
        assert.deepEqual(got?.channelMemberIds, ["dave", "erin"]);
        assert.equal(got?.slackChannel?.channelId, "C1");
        assert.equal(got?.slackChannel?.linkedBy, "bob");
        assert.deepEqual(
          (await restarted.listForMember("dave")).map((p) => p.id),
          [project.id],
        );
        assert.deepEqual(
          (await restarted.listForMember("carol")).map((p) => p.id),
          [other.id],
        );
        assert.deepEqual(
          (await restarted.listForMember("alice")).map((p) => p.id),
          [project.id],
        );
        assert.deepEqual(await restarted.listForMember("gone"), []);
        assert.deepEqual(
          (await restarted.listLinked()).map((p) => p.id),
          [project.id],
        );
        assert.deepEqual(await restarted.members(projectGroupRef(project.id)), ["alice", "bob", "dave", "erin"]);
        assert.equal(await restarted.version(projectGroupRef(project.id)), String(got?.updatedAt));
      } finally {
        await restarted.close?.();
      }

      assert.equal((await store.setSlackChannel(project.id, "alice", null)).status, "ok");
      const unlinked = await store.get(project.id);
      assert.equal(unlinked?.slackChannel, undefined);
      assert.equal(unlinked?.channelMemberIds, undefined);
      assert.deepEqual(await store.listLinked(), []);
      assert.deepEqual(await store.listForMember("dave"), []);
    });
  });
});

test("projects are isolated per tenant and the same id can exist in both", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, tenant, otherTenant }) => {
    const mine = await withTenant(tenant, () => store.create({ name: "Mine", ownerId: "alice" }));
    ids -= 1;
    const theirs = await withTenant(otherTenant, () => store.create({ name: "Theirs", ownerId: "alice" }));
    assert.equal(theirs.id, mine.id);
    await withTenant(otherTenant, async () => {
      assert.equal((await store.get(mine.id))?.name, "Theirs");
      assert.deepEqual(
        (await store.listForMember("alice")).map((p) => p.name),
        ["Theirs"],
      );
      assert.equal((await store.addMember(mine.id, "alice", "bob")).status, "ok");
      await store.setSlackChannel(mine.id, "alice", { channelId: "C9", channelName: "theirs" });
    });
    await withTenant(tenant, async () => {
      const kept = await store.get(mine.id);
      assert.equal(kept?.name, "Mine");
      assert.deepEqual(kept?.memberIds, ["alice"]);
      assert.deepEqual(await store.listLinked(), []);
      assert.deepEqual(await store.listForMember("bob"), []);
    });
  });
});

test(
  "the conversion backfills the most common org's projects into the instance tenant and drops the old table",
  { skip },
  async () => {
    const roadmap = {
      id: "p1",
      name: "Roadmap",
      ownerId: "alice",
      memberIds: ["alice", "bob"],
      channelMemberIds: ["carol"],
      slackChannel: { channelId: "C1", channelName: "roadmap", linkedBy: "alice", linkedAt: 5 },
      createdAt: 1,
      updatedAt: 2,
    };
    await withTypedTableDb(
      make,
      async ({ store, admin, tenant }) => {
        assert.deepEqual(await withTenant(tenant, () => store.get("p1")), roadmap);
        assert.deepEqual(await withTenant(tenant, () => store.get("p2")), {
          id: "p2",
          name: "Plain",
          ownerId: "bob",
          memberIds: ["bob"],
          createdAt: 3,
          updatedAt: 4,
        });
        const { rows } = await admin.query(
          `SELECT tenant_id::text AS tenant, id, to_regclass('projects_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'projects') AS versions
           FROM projects ORDER BY id`,
        );
        assert.deepEqual(rows, [
          { tenant, id: "halfLink", dropped: true, versions: 0 },
          { tenant, id: "noMembers", dropped: true, versions: 0 },
          { tenant, id: "p1", dropped: true, versions: 0 },
          { tenant, id: "p2", dropped: true, versions: 0 },
        ]);
        const { slackChannel: _link, ...unlinked } = roadmap;
        assert.deepEqual(await withTenant(tenant, () => store.get("halfLink")), { ...unlinked, id: "halfLink" });
        assert.deepEqual((await withTenant(tenant, () => store.get("noMembers")))?.memberIds, ["alice"]);
      },
      (admin) =>
        seedKeyValueTable(admin, "projects", {
          p1: { ...roadmap, orgId: "acme" },
          p2: {
            id: "p2",
            orgId: "acme",
            name: "Plain",
            ownerId: "bob",
            memberIds: ["bob"],
            createdAt: 3,
            updatedAt: 4,
          },
          noMembers: { ...roadmap, orgId: "acme", id: "noMembers", memberIds: "alice" },
          halfLink: { ...roadmap, orgId: "acme", id: "halfLink", slackChannel: { channelId: "C2" } },
          ownerless: { ...roadmap, orgId: "acme", id: "ownerless", ownerId: undefined },
          otherOrg: { ...roadmap, orgId: "beta", id: "otherOrg" },
          orgless: { ...roadmap, id: "orgless" },
        }),
    );
  },
);

test("project text with NUL bytes is stored without them", { skip }, async () => {
  await withTypedTableDb(make, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      const project = await store.create({ name: "Road\u0000map", ownerId: "alice" });
      assert.equal((await store.rename(project.id, "alice", "Next\u0000step")).status, "ok");
      const linked = await store.setSlackChannel(project.id, "alice", { channelId: "C1", channelName: "ch\u0000an" });
      assert.equal(linked.status, "ok");
      const got = await store.get(project.id);
      assert.equal(got?.name, "Nextstep");
      assert.equal(got?.slackChannel?.channelName, "chan");
    });
  });
});

test(
  "row security alone hides other tenants' projects from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(make, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.create({ name: "Mine", ownerId: "alice" }));
      const app = createPgPool(url);
      try {
        const names = (bound: string) => withTenant(bound, () => app.q(`SELECT name FROM projects`));
        assert.deepEqual(await names(tenant), [{ name: "Mine" }]);
        assert.deepEqual(await names(otherTenant), []);
        await assert.rejects(app.q(`SELECT name FROM projects`), /No tenant is bound/);
        await assert.rejects(store.listLinked(), /No tenant is bound/);
      } finally {
        await app.close();
      }
    });
  },
);
