import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, migrateRegisteredPgSchemas, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createItemsPromotion, ITEMS_CUTOVER_ID } from "../src/sessions/items-promotion.ts";
import { ItemsCopyOperator } from "../scripts/ops/items-copy.ts";
import { scopeId } from "../src/types.ts";

const url = process.env.DATABASE_URL;

test("staged core stays on the verified copy until authenticated promotion completes", { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  createPostgresSessionStore(url!);
  const migrations = registeredPgMigrations(url!);
  let a: Awaited<ReturnType<typeof createItemsPromotion>> | undefined;
  let b: typeof a;
  let staged: ReturnType<typeof createPostgresSessionStore> | undefined;
  try {
    await applyPgMigrations(
      pool,
      migrations.filter((m) => m.id < "sessions/store/0035-items"),
    );
    const id = randomUUID();
    await pool.query(
      "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at,messages) VALUES($1,'dm','personal:alice','web:promotion',1,1)",
      [id],
    );
    await pool.query(
      "INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at) VALUES($1,0,'user','{\"text\":\"before\"}','personal:alice',1)",
      [id],
    );
    const op = new ItemsCopyOperator(client);
    await op.prepare();
    await assert.rejects(createItemsPromotion(url!), /verified staged copy/);
    while (await op.copyBatch()) continue;
    await op.completeCopy();
    await op.verify();
    await assert.rejects(createItemsPromotion(url!), /indexes ready/);
    await op.indexes();
    const stageUrl = new URL(url!);
    stageUrl.searchParams.set("application_name", "staged-promotion-test");
    staged = createPostgresSessionStore(stageUrl.toString(), { stageItemsCutover: true });
    assert.ok(
      !registeredPgMigrations(stageUrl.toString()).some((m) =>
        ["sessions/store/0035-items", ITEMS_CUTOVER_ID].includes(m.id),
      ),
    );
    await migrateRegisteredPgSchemas(stageUrl.toString());
    assert.equal((await pool.query("SELECT to_regclass('session_entries') AS name")).rows[0].name, "session_entries");
    a = await createItemsPromotion(url!);
    b = await createItemsPromotion(url!);
    assert.equal(a.ready(), false);
    const abort = new AbortController();
    const cancelled = a.wait(abort.signal);
    abort.abort(new Error("cancelled waiter"));
    await assert.rejects(cancelled, /cancelled waiter/);
    await pool.query("INSERT INTO session_leases(session_id,token,expires_at) VALUES($1,'old-writer',$2)", [
      id,
      Date.now() + 300_000,
    ]);
    await assert.rejects(a.promote(false), /confirmed stopped writers/);
    await assert.rejects(op.finish(true), /active session leases/);
    const fingerprint = (await pool.query("SELECT fingerprint FROM items_copy_ops.state")).rows[0].fingerprint;
    await pool.query("UPDATE items_copy_ops.state SET fingerprint='invalid'");
    await assert.rejects(a.promote(true), /verified staged copy/);
    assert.equal(a.ready(), false);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_leases")).rows[0].n, 1);
    await pool.query("UPDATE items_copy_ops.state SET fingerprint=$1", [fingerprint]);
    const waiting = a.wait();
    await Promise.all([a.promote(true), a.promote(true), b.promote(true)]);
    await waiting;
    assert.equal(a.ready(), true);
    assert.equal(await b.refresh(), true);
    await a.promote(true);
    assert.equal((await pool.query("SELECT to_regclass('session_entries') AS name")).rows[0].name, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_leases")).rows[0].n, 0);
    const { lease } = await staged.acquireLease(id);
    assert.ok(lease);
    await staged.append(lease, {
      type: "assistant",
      payload: { text: "after" },
      scopeLabel: scopeId("personal", "alice"),
    });
    await staged.releaseLease(lease);
    assert.deepEqual(
      (await pool.query("SELECT text FROM items ORDER BY seq")).rows.map((r) => r.text),
      ["before", "after"],
    );
    await applyPgMigrations(pool, migrations);
    await pool.query("UPDATE qm_schema_migrations SET checksum='invalid' WHERE id=$1", [ITEMS_CUTOVER_ID]);
    await assert.rejects(createItemsPromotion(url!), /checksum mismatch/);
  } finally {
    await a?.close();
    await b?.close();
    await client.end();
    await pool.end();
  }
});
