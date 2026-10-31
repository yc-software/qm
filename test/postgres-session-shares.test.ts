import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresSessionShareStore, type SessionShare } from "../src/sessions/session-share.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

const share = (token: string, overrides: Partial<SessionShare> = {}): SessionShare => ({
  token,
  sessionId: "session-1",
  audience: "external",
  createdBy: "U1",
  createdAt: 100,
  visibility: { minSeq: 1, maxSeq: 9, minCreatedAt: 10, maxCreatedAt: 90 },
  messages: [
    { role: "user", text: "hi\u0000 there" },
    {
      role: "assistant",
      text: "file",
      attachments: [{ id: "a1", name: "x.png", mimetype: "image/png", sizeBytes: 3 }],
    },
  ],
  files: [{ id: "a1", name: "x.png", mimetype: "image/png", sizeBytes: 3, blobKey: "blob-1" }],
  ...overrides,
});

test("a share round-trips its frozen messages, files and visibility bounds", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresSessionShareStore(url),
    async ({ store, tenant }) =>
      withTenant(tenant, async () => {
        await store.create(share("t1"));
        assert.deepEqual(await store.get("t1"), {
          ...share("t1"),
          messages: [{ role: "user", text: "hi there" }, share("t1").messages[1]],
        });
        assert.equal(await store.get("missing"), null);
        await assert.rejects(store.create(share("t1")));
      }),
  );
});

test("share tokens are scoped to their tenant", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresSessionShareStore(url),
    async ({ store, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.create(share("t1")));
      assert.equal(await withTenant(otherTenant, () => store.get("t1")), null);
      await withTenant(otherTenant, () => store.create(share("t1", { sessionId: "session-other" })));
      assert.equal((await withTenant(tenant, () => store.get("t1")))?.sessionId, "session-1");
      assert.equal((await withTenant(otherTenant, () => store.get("t1")))?.sessionId, "session-other");
    },
  );
});

test(
  "the conversion backfills well-formed shares into the instance tenant and drops the old table",
  { skip },
  async () => {
    const { token: _token, ...stored } = share("t1");
    await withTypedTableDb(
      (url) => createPostgresSessionShareStore(url),
      async ({ store, admin, tenant }) => {
        assert.deepEqual(await withTenant(tenant, () => store.get("t1")), {
          ...share("t1"),
          messages: [{ role: "user", text: "hi there" }, share("t1").messages[1]],
        });
        const { rows } = await admin.query(
          `SELECT tenant_id::text AS tenant, token, to_regclass('session_shares_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'session_shares') AS versions
           FROM session_shares`,
        );
        assert.deepEqual(rows, [{ tenant, token: "t1", dropped: true, versions: 0 }]);
      },
      (admin) =>
        seedKeyValueTable(admin, "session_shares", {
          t1: { token: "t1", ...stored, messages: [{ role: "user", text: "hi there" }, stored.messages[1]] },
          broken: { token: "broken", sessionId: "session-1", audience: "everyone", createdBy: "U1", createdAt: 1 },
        }),
    );
  },
);

test(
  "row security alone hides other tenants' shares from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresSessionShareStore(url),
      async ({ store, url, tenant, otherTenant }) => {
        await withTenant(tenant, () => store.create(share("t1")));
        const app = createPgPool(url);
        try {
          const tokens = (bound: string) => withTenant(bound, () => app.q(`SELECT token FROM session_shares`));
          assert.deepEqual(await tokens(tenant), [{ token: "t1" }]);
          assert.deepEqual(await tokens(otherTenant), []);
          await assert.rejects(app.q(`SELECT token FROM session_shares`), /No tenant is bound/);
          await assert.rejects(store.get("t1"), /No tenant is bound/);
        } finally {
          await app.close();
        }
      },
    );
  },
);
