import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AdminGrant, AdminGrantPersistence, AdminRole } from "./admin-grant-store.ts";

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
  const pg = createPgPool(connectionString, SCHEMA_SQL);

  return {
    async all() {
      const rows = await pg.q("SELECT principal_id, scope_id, role, granted_by, created_at FROM admin_grants");
      return rows.map(rowToGrant);
    },
    async put(g) {
      await pg.query(
        `INSERT INTO admin_grants (principal_id, scope_id, role, granted_by, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (principal_id, scope_id, role)
         DO UPDATE SET granted_by = EXCLUDED.granted_by, created_at = EXCLUDED.created_at`,
        [g.principalId, g.scopeId, g.role, g.grantedBy ?? null, g.createdAt ?? null],
      );
    },
    async remove(principalId, scopeId, role) {
      await pg.query("DELETE FROM admin_grants WHERE principal_id = $1 AND scope_id = $2 AND role = $3", [
        principalId,
        scopeId,
        role,
      ]);
    },
  };
}
