import { createPgPool, tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import { perTenant } from "../tenant.ts";
import type { Grant, Permission, ScopeId } from "../types.ts";
import type { GrantPersistence } from "./acl-store.ts";

function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    ownerScopeId: r.owner_scope_id as ScopeId,
    ref: r.path as string,
    granteeScopeId: r.grantee_scope_id as ScopeId,
    permission: r.permission as Permission,
    grantedBy: r.granted_by as string,
  };
}

export function createPostgresGrantStore(connectionString: string): GrantPersistence {
  const db = createPgPool(connectionString, []);
  const { q } = db;
  const cached = perTenant(() => ({ at: null as { v: string; grants: readonly Grant[] } | null }));

  return {
    async all() {
      const cache = cached();
      const versionRows = await q("SELECT v FROM acl_grants_version");
      const version = versionRows.length ? String(versionRows[0]!.v) : null;
      if (cache.at && version !== null && cache.at.v === version) return [...cache.at.grants];
      const rows = await q(
        "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants ORDER BY owner_scope_id, path, grantee_scope_id, permission",
      );
      const grants = rows.map(rowToGrant);
      cache.at = version === null ? null : { v: version, grants };
      return [...grants];
    },
    async put(g) {
      await withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          `INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (${tenantCols("owner_scope_id, path, grantee_scope_id, permission")})
           DO UPDATE SET granted_by = EXCLUDED.granted_by`,
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission, g.grantedBy],
        );
      });
    },
    async remove(g) {
      await withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          "DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 AND grantee_scope_id = $3 AND permission = $4",
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission],
        );
      });
    },
    async replaceForResourceIfCurrent(ownerScopeId, ref, expected, replacement) {
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${ownerScopeId}\n${ref}`]);
        const selected = await client.query(
          "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 FOR UPDATE",
          [ownerScopeId, ref],
        );
        const current = selected.rows.map(rowToGrant);
        const sameTuple = (a: Grant, b: Grant) =>
          a.ownerScopeId === b.ownerScopeId &&
          a.ref === b.ref &&
          a.granteeScopeId === b.granteeScopeId &&
          a.permission === b.permission &&
          a.grantedBy === b.grantedBy;
        if (
          current.length !== expected.length ||
          current.some((grant) => !expected.some((candidate) => sameTuple(grant, candidate)))
        ) {
          return false;
        }
        await client.query("DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2", [ownerScopeId, ref]);
        for (const grant of replacement) {
          await client.query(
            "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5)",
            [grant.ownerScopeId, grant.ref, grant.granteeScopeId, grant.permission, grant.grantedBy],
          );
        }
        return true;
      });
    },
  };
}
