import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { Principal } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const message = (id: string, recipientId: string, createdAt: number, extra: Partial<SessionMessage> = {}) => ({
  id,
  recipientId,
  senderId: "sender",
  actor,
  text: `text ${id}`,
  audience: [actor],
  createdAt,
  ...extra,
});

test("pending returns unread mail oldest first and acknowledgement needs the recipient", { skip }, async () => {
  await withTypedTableDb(createPostgresSessionMailbox, async ({ store, url, tenant }) => {
    await withTenant(tenant, async () => {
      await store.send(message("b", "inbox", 2, { sourceEntrySeq: 7 }));
      await store.send(message("a", "inbox", 1, { text: "body\u0000" }));
      await store.send(message("a", "inbox", 1, { text: "replacement" }));
      await store.send(message("c", "elsewhere", 0));
      assert.deepEqual(await store.pending("inbox"), [
        message("a", "inbox", 1, { text: "body" }),
        message("b", "inbox", 2, { sourceEntrySeq: 7 }),
      ]);
      await store.acknowledge("elsewhere", ["a", "b"]);
      assert.equal((await store.pending("inbox")).length, 2);
      await store.acknowledge("inbox", ["a"]);
      await store.acknowledge("inbox", []);
    });
    const restarted = createPostgresSessionMailbox(url);
    try {
      assert.deepEqual(
        (await withTenant(tenant, () => restarted.pending("inbox"))).map((row) => row.id),
        ["b"],
      );
    } finally {
      await restarted.close?.();
    }
  });
});

test("mail is confined to its tenant and unbound access fails closed", { skip }, async () => {
  await withTypedTableDb(createPostgresSessionMailbox, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, () => store.send(message("m", "inbox", 1)));
    assert.deepEqual(await withTenant(otherTenant, () => store.pending("inbox")), []);
    await withTenant(otherTenant, () => store.acknowledge("inbox", ["m"]));
    await withTenant(otherTenant, () => store.send(message("m", "inbox", 5, { text: "other" })));
    assert.deepEqual(
      (await withTenant(tenant, () => store.pending("inbox"))).map((row) => row.text),
      ["text m"],
    );
    assert.deepEqual(
      (await withTenant(otherTenant, () => store.pending("inbox"))).map((row) => row.text),
      ["other"],
    );
    await assert.rejects(store.pending("inbox"), /No tenant is bound/);
    await assert.rejects(store.send(message("n", "inbox", 1)), /No tenant is bound/);
  });
});

test("the conversion backfills mail into the instance tenant and drops the old table", { skip }, async () => {
  await withTypedTableDb(
    createPostgresSessionMailbox,
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.pending("inbox")), [
        message("unread", "inbox", 1, { sourceEntrySeq: 3 }),
      ]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, recipient_id, source_entry_seq::int AS seq, consumed,
                to_regclass('session_mailbox_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'session_mailbox') AS versions,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'session_mailbox'::regclass) AS rls
           FROM session_mailbox ORDER BY id`,
      );
      const row = { tenant, recipient_id: "inbox", dropped: true, versions: 0, rls: true };
      assert.deepEqual(rows, [
        { ...row, id: "read", seq: null, consumed: true },
        { ...row, id: "unread", seq: 3, consumed: false },
      ]);
    },
    (admin) =>
      seedKeyValueTable(admin, "session_mailbox", {
        unread: message("unread", "inbox", 1, { sourceEntrySeq: 3 }),
        read: message("read", "inbox", 0, { consumed: true }),
      }),
  );
});
