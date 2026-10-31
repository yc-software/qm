import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";

const BASE = process.env.DATABASE_URL;
const skip = BASE ? false : "set DATABASE_URL (a Postgres) to run the ACL file-ID migration test";
const schema = `acl_file_ids_${randomBytes(4).toString("hex")}`;

after(async () => {
  if (!BASE) return;
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: BASE });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("file grants move from owner paths to enabled Files record IDs", { skip }, async () => {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: BASE });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(BASE!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = url.toString();
  const grants = createPostgresGrantStore(db);
  createPostgresFileArtifactStore(db, createMemoryDurableByteStore());
  await migrateRegisteredPgSchemas(db);
  const pool = new pg.Pool({ connectionString: db });
  try {
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = 'acl/grants/0003-file-ids'");
    const file = (id: string, owner: string, path: string, createdAt: number, enabled = true) =>
      pool.query(
        `INSERT INTO file_artifacts (id, owner_scope_id, path, name, mimetype, size_bytes, direction, created_by, created_at, updated_at, enabled)
         VALUES ($1, $2, $3, 'a.md', 'text/markdown', 1, 'out', 'U1', $4, $4, $5)`,
        [id, owner, path, createdAt, enabled],
      );
    await file("old", "personal:U1", "reports/a.md", 1);
    await file("new", "personal:U1", "reports/a.md", 2);
    await file("gone", "personal:U1", "reports/a.md", 3, false);
    await file("theirs", "personal:U9", "reports/b.md", 1);
    await file("kept", "personal:U1", "reports/c.md", 1);
    const rows: [string, string, string, string][] = [
      ["reports/a.md", "personal:U2", "read", "path-grantor"],
      ["reports/a.md", "personal:U3", "read", "path-grantor"],
      ["new", "personal:U3", "read", "id-grantor"],
      ["reports/b.md", "personal:U2", "read", "U1"],
      ["reports/missing.md", "personal:U2", "read", "U1"],
      ["gone", "personal:U2", "read", "U1"],
      ["theirs", "personal:U2", "read", "U1"],
      ["kept", "personal:U2", "write", "U1"],
      ["skill:s1", "personal:U2", "use", "U1"],
      ["deployment:d1", "personal:U2", "read", "U1"],
      ["cron:c1", "personal:U2", "manage", "U1"],
      ["service-cred:github", "personal:U2", "use", "U1"],
    ];
    for (const [path, grantee, permission, by] of rows) {
      await pool.query(
        "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ('personal:U1', $1, $2, $3, $4)",
        [path, grantee, permission, by],
      );
    }

    await migrateRegisteredPgSchemas(db);

    assert.deepEqual(
      (await grants.all()).map((g) => [g.ref, g.granteeScopeId, g.permission, g.grantedBy]),
      [
        ["cron:c1", "personal:U2", "manage", "U1"],
        ["deployment:d1", "personal:U2", "read", "U1"],
        ["kept", "personal:U2", "write", "U1"],
        ["new", "personal:U2", "read", "path-grantor"],
        ["new", "personal:U3", "read", "id-grantor"],
        ["service-cred:github", "personal:U2", "use", "U1"],
        ["skill:s1", "personal:U2", "use", "U1"],
      ],
    );
  } finally {
    await pool.end();
    await admin.end();
  }
});
