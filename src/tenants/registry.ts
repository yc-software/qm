import {
  sealTenantSecrets,
  TENANT_COLUMNS,
  TENANT_TEXT_SETTINGS,
  tenantFromRow,
  type TenantEnvSettings,
  type TenantSettings,
} from "../../plugins/chassis/src/tenant-settings.ts";
import type { PgPool } from "../persistence/pg-pool.ts";

export type { TenantSecrets, TenantSettings } from "../../plugins/chassis/src/tenant-settings.ts";
export { tenantSecretsKey } from "../../plugins/chassis/src/tenant-settings.ts";

export type TenantRecord = TenantSettings & { id: string };

export async function listTenants(pool: PgPool, key: Buffer | undefined): Promise<TenantRecord[]> {
  const rows = await pool.q(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at, slug`);
  return rows.map((row) => tenantFromRow(row, key));
}

export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

const settingValues = (rec: TenantEnvSettings) => TENANT_TEXT_SETTINGS.map(([field]) => rec[field] ?? null);

export async function upsertTenant(pool: SqlRunner, rec: TenantRecord, key: Buffer | undefined): Promise<void> {
  const columns = TENANT_TEXT_SETTINGS.map(([, column]) => column);
  const at = (i: number) => `$${i + 8}`;
  await pool.query(
    `INSERT INTO tenants(id, slug, org_id, hosts, status, oidc_admin, secrets, ${columns.join(", ")})
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${columns.map((_, i) => at(i)).join(", ")})
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, org_id = EXCLUDED.org_id, hosts = EXCLUDED.hosts,
       status = EXCLUDED.status, oidc_admin = EXCLUDED.oidc_admin, secrets = EXCLUDED.secrets,
       ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}, updated_at = now()`,
    [
      rec.id,
      rec.slug,
      rec.orgId,
      rec.hosts,
      rec.status,
      rec.oidcAdmin,
      sealTenantSecrets(rec.secrets, key),
      ...settingValues(rec),
    ],
  );
}

export async function homeTenantId(pool: PgPool): Promise<string> {
  const rows = await pool.q("SELECT id::text AS id FROM qm_tenant");
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("qm_tenant has no row; run migrations first");
  return id;
}

export async function assertRowSecurityEnforced(pool: PgPool): Promise<void> {
  const rows = await pool.q("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
  if (rows[0]?.bypass === true) {
    throw new Error(
      "multitenant: the database login is a superuser or has BYPASSRLS, so row-level security would not separate tenants",
    );
  }
}
