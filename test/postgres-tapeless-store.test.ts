import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the tapeless store test";

test("migrations drop an empty session_tape and the store keeps working without it", { skip }, async () => {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `tapeless_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  const store = createPostgresSessionStore(url.toString());
  try {
    await applyPgMigrations(raw, registeredPgMigrations(url.toString()));
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("web:tapeless", "dm", scope, undefined, "web");
    await store.addParticipant(session.id, "alice");
    const { lease } = await store.acquireLease(session.id);
    await store.append(lease!, {
      type: "user",
      payload: { text: "before the drop" },
      scopeLabel: scope,
    });

    assert.equal((await raw.query("SELECT to_regclass('session_tape') AS t")).rows[0].t, null);
    await applyPgMigrations(raw, registeredPgMigrations(url.toString()));
    assert.equal((await raw.query("SELECT to_regclass('session_tape') AS t")).rows[0].t, null);

    await store.append(lease!, { type: "assistant", payload: { text: "after the drop" }, scopeLabel: scope });
    await store.releaseLease(lease!);
    assert.deepEqual(
      (await store.visibleEntries(session.id, "alice")).map((entry) => (entry.payload as { text: string }).text),
      ["before the drop", "after the drop"],
    );
    await store.deleteSession(session.id);
    assert.equal(await store.get(session.id), null);
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
