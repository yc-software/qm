import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import {
  ADMIN_GRANT_BOOTSTRAP_ACTOR,
  ADMIN_GRANT_BOOTSTRAP_TIME,
  type AdminGrant,
  type AdminGrantPersistence,
  type AdminRole,
} from "./admin-grant-store.ts";

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
    async reconcileBootstrap(grants) {
      const principalIds = grants.map((grant) => grant.principalId);
      const scopeIds = grants.map((grant) => grant.scopeId);
      const roles = grants.map((grant) => grant.role);
      await withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["admin-grants-bootstrap"]);
        await client.query(
          `INSERT INTO admin_grants (principal_id, scope_id, role, granted_by, created_at)
           SELECT principal_id, scope_id, role, $4, $5
           FROM unnest($1::text[], $2::text[], $3::text[]) AS desired(principal_id, scope_id, role)
           ON CONFLICT (principal_id, scope_id, role) DO NOTHING`,
          [principalIds, scopeIds, roles, ADMIN_GRANT_BOOTSTRAP_ACTOR, ADMIN_GRANT_BOOTSTRAP_TIME],
        );
        await client.query(
          `DELETE FROM admin_grants AS stored
           WHERE stored.granted_by = $4
             AND stored.created_at = $5
             AND NOT EXISTS (
               SELECT 1
               FROM unnest($1::text[], $2::text[], $3::text[]) AS desired(principal_id, scope_id, role)
               WHERE desired.principal_id = stored.principal_id
                 AND desired.scope_id = stored.scope_id
                 AND desired.role = stored.role
             )`,
          [principalIds, scopeIds, roles, ADMIN_GRANT_BOOTSTRAP_ACTOR, ADMIN_GRANT_BOOTSTRAP_TIME],
        );
      });
    },
  };
}
