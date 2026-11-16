import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AdminGrant, AdminGrantPersistence, AdminRole } from "./admin-grant-store.ts";
import { tenantTables } from "../tenants/migrations.ts";

function rowToGrant(r: Record<string, unknown>): AdminGrant {
  return {
    principalId: r.principal_id as string,
    scopeId: r.scope_id as ScopeId,
    role: r.role as AdminRole,
    grantedBy: (r.granted_by as string | null) ?? undefined,
    createdAt: r.created_at == null ? undefined : Number(r.created_at),
  };
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS admin_grants(
    principal_id TEXT   NOT NULL,
    scope_id     TEXT   NOT NULL,
    role         TEXT   NOT NULL,
    granted_by   TEXT,
    created_at   BIGINT,
    PRIMARY KEY (principal_id, scope_id, role)
  )`,
];

export function createPostgresAdminGrantStore(connectionString: string): AdminGrantPersistence {
  const pg = createPgPool(connectionString, [
    { id: "admin/grants/0001", statements: SCHEMA_SQL },
    ...tenantTables("admin/grants/0002-tenants", [
      { table: "admin_grants", primaryKey: "principal_id, scope_id, role" },
    ]),
  ]);

  return {
    async all(tenant) {
      const rows = await pg
        .forTenant(tenant)
        .q("SELECT principal_id, scope_id, role, granted_by, created_at FROM admin_grants WHERE tenant_id = $1", [
          tenant.id,
        ]);
      return rows.map(rowToGrant);
    },
    async put(tenant, g) {
      await pg.forTenant(tenant).query(
        `INSERT INTO admin_grants (tenant_id, principal_id, scope_id, role, granted_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, principal_id, scope_id, role)
         DO UPDATE SET granted_by = EXCLUDED.granted_by, created_at = EXCLUDED.created_at`,
        [tenant.id, g.principalId, g.scopeId, g.role, g.grantedBy ?? null, g.createdAt ?? null],
      );
    },
    async insertIfAbsent(tenant, g) {
      const result = await pg.forTenant(tenant).query(
        `INSERT INTO admin_grants (tenant_id, principal_id, scope_id, role, granted_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, principal_id, scope_id, role) DO NOTHING`,
        [tenant.id, g.principalId, g.scopeId, g.role, g.grantedBy ?? null, g.createdAt ?? null],
      );
      return result.rowCount > 0;
    },
    async remove(tenant, principalId, scopeId, role) {
      await pg
        .forTenant(tenant)
        .query("DELETE FROM admin_grants WHERE tenant_id = $1 AND principal_id = $2 AND scope_id = $3 AND role = $4", [
          tenant.id,
          principalId,
          scopeId,
          role,
        ]);
    },
  };
}
