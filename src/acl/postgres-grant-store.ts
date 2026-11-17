import { createPgPool, type PoolClient } from "../persistence/pg-pool.ts";
import type { Grant, Permission, ScopeId } from "../types.ts";
import { sameGrantSet, type GrantPersistence } from "./acl-store.ts";
import { refPrefix } from "./resource-ref.ts";
import { likeEscape } from "../persistence/like.ts";

export function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    ownerScopeId: r.owner_scope_id as ScopeId,
    ref: r.path as string,
    granteeScopeId: r.grantee_scope_id as ScopeId,
    permission: r.permission as Permission,
    grantedBy: r.granted_by as string,
  };
}

export function createPostgresGrantStore(connectionString: string): GrantPersistence {
  const db = createPgPool(connectionString);
  const lockResource = (client: PoolClient, ownerScopeId: ScopeId, ref: string) =>
    client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${ownerScopeId}\n${ref}`]);

  return {
    async find(tenant, query) {
      const params: unknown[] = [tenant.id];
      const where: string[] = ["tenant_id = $1"];
      const match = (condition: (param: string) => string, value: unknown) => {
        params.push(value);
        where.push(condition(`$${params.length}`));
      };
      if (query.ownerScopeId !== undefined) match((p) => `owner_scope_id = ${p}`, query.ownerScopeId);
      if (query.ref !== undefined) match((p) => `path = ${p}`, query.ref);
      if (query.kind !== undefined) match((p) => `path LIKE ${p}`, `${likeEscape(refPrefix(query.kind))}%`);
      if (query.granteeScopeIds !== undefined) match((p) => `grantee_scope_id = ANY(${p})`, [...query.granteeScopeIds]);
      if (query.resources !== undefined) {
        params.push(
          query.resources.map((r) => r.ownerScopeId),
          query.resources.map((r) => r.ref),
        );
        where.push(
          `(owner_scope_id, path) IN (SELECT * FROM unnest($${params.length - 1}::text[], $${params.length}::text[]))`,
        );
      }
      const rows = await db
        .forTenant(tenant)
        .q(
          `SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants WHERE ${where.join(" AND ")} ORDER BY owner_scope_id, path, grantee_scope_id, permission`,
          params,
        );
      return rows.map(rowToGrant);
    },
    async put(tenant, g) {
      await db.forTenant(tenant).transaction(async (client) => {
        await lockResource(client, g.ownerScopeId, g.ref);
        await client.query(
          `INSERT INTO acl_grants (tenant_id, owner_scope_id, path, grantee_scope_id, permission, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, owner_scope_id, path, grantee_scope_id, permission)
           DO UPDATE SET granted_by = EXCLUDED.granted_by`,
          [tenant.id, g.ownerScopeId, g.ref, g.granteeScopeId, g.permission, g.grantedBy],
        );
      });
    },
    async remove(tenant, g) {
      await db.forTenant(tenant).transaction(async (client) => {
        await lockResource(client, g.ownerScopeId, g.ref);
        await client.query(
          "DELETE FROM acl_grants WHERE tenant_id = $1 AND owner_scope_id = $2 AND path = $3 AND grantee_scope_id = $4 AND permission = $5",
          [tenant.id, g.ownerScopeId, g.ref, g.granteeScopeId, g.permission],
        );
      });
    },
    async replaceForResourceIfCurrent(tenant, ownerScopeId, ref, expected, replacement) {
      return db.forTenant(tenant).transaction(async (client) => {
        await lockResource(client, ownerScopeId, ref);
        const selected = await client.query(
          "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants WHERE tenant_id = $1 AND owner_scope_id = $2 AND path = $3 FOR UPDATE",
          [tenant.id, ownerScopeId, ref],
        );
        const current = selected.rows.map(rowToGrant);
        if (!sameGrantSet(current, expected)) return false;
        await client.query("DELETE FROM acl_grants WHERE tenant_id = $1 AND owner_scope_id = $2 AND path = $3", [
          tenant.id,
          ownerScopeId,
          ref,
        ]);
        for (const grant of replacement) {
          await client.query(
            "INSERT INTO acl_grants (tenant_id, owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5, $6)",
            [tenant.id, grant.ownerScopeId, grant.ref, grant.granteeScopeId, grant.permission, grant.grantedBy],
          );
        }
        return true;
      });
    },
  };
}
