import type { PoolClient } from "pg";

export async function movePersonalScope(client: PoolClient, fromUserId: string, toScope: string): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS personal_scope_moves(tenant_id uuid, alias text, to_scope text) ON COMMIT DROP`,
  );
  await client.query(`INSERT INTO personal_scope_moves VALUES (qm_bound_tenant(), $1, $2)`, [fromUserId, toScope]);
  await client.query(`SELECT FROM qm_move_exact_personal_scopes()`);
  await client.query(`DELETE FROM personal_scope_moves`);
}
