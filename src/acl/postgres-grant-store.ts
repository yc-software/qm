import { createPgPool } from "../persistence/pg-pool.ts";
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
  const db = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS acl_grants(
        owner_scope_id   TEXT NOT NULL,
        path             TEXT NOT NULL,
        grantee_scope_id TEXT NOT NULL,
        permission       TEXT NOT NULL,
        granted_by       TEXT NOT NULL,
        PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission)
      )`,
    `CREATE TABLE IF NOT EXISTS acl_grants_version(
        only_row BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row),
        v        BIGINT NOT NULL
      )`,
    `INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 0) ON CONFLICT (only_row) DO NOTHING`,
    `CREATE OR REPLACE FUNCTION acl_grants_bump_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
        ON CONFLICT (only_row) DO UPDATE SET v = acl_grants_version.v + 1;
        RETURN NULL;
      END
      $fn$`,
    `DROP TRIGGER IF EXISTS acl_grants_bump ON acl_grants`,
    `CREATE TRIGGER acl_grants_bump
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON acl_grants
      FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version()`,
  ]);
  const { q } = db;
  let cache: { v: string; grants: readonly Grant[] } | null = null;

  return {
    async all() {
      const versionRows = await q("SELECT v FROM acl_grants_version");
      const version = versionRows.length ? String(versionRows[0]!.v) : null;
      if (cache && version !== null && cache.v === version) return [...cache.grants];
      const rows = await q(
        "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants ORDER BY owner_scope_id, path, grantee_scope_id, permission",
      );
      const grants = rows.map(rowToGrant);
      cache = version === null ? null : { v: version, grants };
      return [...grants];
    },
    async put(g) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          `INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (owner_scope_id, path, grantee_scope_id, permission)
           DO UPDATE SET granted_by = EXCLUDED.granted_by`,
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission, g.grantedBy],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async remove(g) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${g.ownerScopeId}\n${g.ref}`]);
        await client.query(
          "DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2 AND grantee_scope_id = $3 AND permission = $4",
          [g.ownerScopeId, g.ref, g.granteeScopeId, g.permission],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async replaceForResourceIfCurrent(ownerScopeId, ref, expected, replacement) {
      const client = await (await db.pool()).connect();
      try {
        await client.query("BEGIN");
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
          await client.query("ROLLBACK");
          return false;
        }
        await client.query("DELETE FROM acl_grants WHERE owner_scope_id = $1 AND path = $2", [ownerScopeId, ref]);
        for (const grant of replacement) {
          await client.query(
            "INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1, $2, $3, $4, $5)",
            [grant.ownerScopeId, grant.ref, grant.granteeScopeId, grant.permission, grant.grantedBy],
          );
        }
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
