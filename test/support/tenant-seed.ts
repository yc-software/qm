import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { SESSION_MIGRATIONS, TENANT_BACKFILL } from "../../src/sessions/session-schema.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";

const TEST_INSTALL_TENANT = "00000000-0000-4000-8000-000000000001";

const RELEASED_SESSION_MIGRATION_IDS = new Set([
  "0000-tenancy/base",
  "sessions/store/0047-base-schema",
  "sessions/store/0048-message-search-index",
  "sessions/store/0049-drop-items-search",
  "sessions/store/0050-tenant-backfill",
  "sessions/store/0051-spend-recovery-index",
  "sessions/store/0052-session-facts",
  "sessions/store/0054-session-facts-copy",
]);

export const RELEASED_SESSION_MIGRATIONS = SESSION_MIGRATIONS.filter(({ id }) =>
  RELEASED_SESSION_MIGRATION_IDS.has(id),
);

export async function seedInstallTenant(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const statement of TENANCY_BASE.statements) await client.query(statement);
    await client.query("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [TEST_INSTALL_TENANT]);
  } finally {
    await client.end();
  }
}

export async function seedReleasedInstall(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await applyPgMigrations(
      pool,
      RELEASED_SESSION_MIGRATIONS.filter((migration) => migration !== TENANT_BACKFILL).map(definePgMigration),
    );
    await pool.query("UPDATE qm_tenant SET id = $1", [TEST_INSTALL_TENANT]);
    await applyPgMigrations(pool, [definePgMigration(TENANT_BACKFILL)]);
  } finally {
    await pool.end();
  }
}
