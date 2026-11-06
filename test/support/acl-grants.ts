import { createPgPool, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { rowToGrant } from "../../src/acl/postgres-grant-store.ts";
import type { Grant } from "../../src/types.ts";

export async function allGrants(url: string): Promise<Grant[]> {
  await migrateRegisteredPgSchemas(url);
  const pg = createPgPool(url);
  const rows = await pg
    .q(
      "SELECT owner_scope_id, path, grantee_scope_id, permission, granted_by FROM acl_grants ORDER BY owner_scope_id, path, grantee_scope_id, permission",
    )
    .finally(() => pg.close());
  return rows.map(rowToGrant);
}
