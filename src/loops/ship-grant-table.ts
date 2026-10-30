import type { ShipGrant } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { createMemoryRows } from "./memory-rows.ts";
import { columnList, json, kvBigint, kvJsonb, num, present, text, type Row } from "./pg-values.ts";

export interface ShipGrantRows {
  insertIfAbsent(grant: ShipGrant): Promise<ShipGrant>;
  get(id: string): Promise<ShipGrant | null>;
  byLoop(loopId: string): Promise<ShipGrant[]>;
  update(id: string, apply: (grant: ShipGrant) => ShipGrant): Promise<ShipGrant | null>;
  delete(id: string): Promise<void>;
  deleteByLoop(loopId: string): Promise<void>;
  close?(): Promise<void>;
}

export const LOOP_SHIP_GRANTS_MIGRATION = typedTableMigration({
  table: "loop_ship_grants",
  columns: [
    "id TEXT NOT NULL",
    "loop_id TEXT NOT NULL",
    "ship_action TEXT NOT NULL",
    "label TEXT",
    "actor_id TEXT NOT NULL",
    "policy_version INTEGER NOT NULL",
    "created_at BIGINT NOT NULL",
    "revoked_at BIGINT",
    "revoked_by TEXT",
    "revocation_history JSONB",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    loop_id: "json->>'loopId'",
    ship_action: "json->>'shipAction'",
    label: "json->>'label'",
    actor_id: "json->>'actorId'",
    policy_version: "COALESCE((json->>'policyVersion')::integer, 1)",
    created_at: `COALESCE(${kvBigint("createdAt")}, 0)`,
    revoked_at: kvBigint("revokedAt"),
    revoked_by: "json->>'revokedBy'",
    revocation_history: kvJsonb("revocationHistory"),
  },
  where: "json->>'loopId' IS NOT NULL AND json->>'shipAction' IS NOT NULL AND json->>'actorId' IS NOT NULL",
  indexes: ["CREATE INDEX loop_ship_grants_by_loop ON loop_ship_grants(tenant_id, loop_id)"],
});

const { names: COLUMNS, values: PLACEHOLDERS } = columnList([
  ["id", "text"],
  ["loop_id", "text"],
  ["ship_action", "text"],
  ["label", "text"],
  ["actor_id", "text"],
  ["policy_version", "integer"],
  ["created_at", "bigint"],
  ["revoked_at", "bigint"],
  ["revoked_by", "text"],
  ["revocation_history", "jsonb"],
]);

const SELECT = `SELECT ${COLUMNS} FROM loop_ship_grants`;

const MINE = `tenant_id = ${TENANT}`;

function params(grant: ShipGrant): unknown[] {
  return [
    grant.id,
    text(grant.loopId),
    text(grant.shipAction),
    text(grant.label),
    text(grant.actorId),
    grant.policyVersion,
    grant.createdAt,
    grant.revokedAt ?? null,
    text(grant.revokedBy),
    json(grant.revocationHistory),
  ];
}

function fromRow(r: Row): ShipGrant {
  return present<ShipGrant>({
    id: r.id,
    loopId: r.loop_id,
    shipAction: r.ship_action,
    label: r.label,
    actorId: r.actor_id,
    policyVersion: r.policy_version,
    createdAt: num(r.created_at),
    revokedAt: num(r.revoked_at),
    revokedBy: r.revoked_by,
    revocationHistory: r.revocation_history,
  });
}

export function createPostgresShipGrantRows(connectionString: string): ShipGrantRows {
  const { q, pool, close } = createPgPool(connectionString, [TENANCY_BASE, LOOP_SHIP_GRANTS_MIGRATION]);
  const get = async (id: string): Promise<ShipGrant | null> => {
    const rows = await q(`${SELECT} WHERE ${MINE} AND id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  };
  return {
    async insertIfAbsent(grant) {
      await q(
        `INSERT INTO loop_ship_grants(${COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT (tenant_id, id) DO NOTHING`,
        params(grant),
      );
      return (await get(grant.id)) ?? grant;
    },
    get,
    async byLoop(loopId) {
      return (await q(`${SELECT} WHERE ${MINE} AND loop_id = $1 ORDER BY id`, [loopId])).map(fromRow);
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(fromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loop_ship_grants SET (${COLUMNS}) = ROW(${PLACEHOLDERS}) WHERE ${MINE} AND id = $1`,
          params(next),
        );
        return present<ShipGrant>(next as unknown as Row);
      });
    },
    async delete(id) {
      await q(`DELETE FROM loop_ship_grants WHERE ${MINE} AND id = $1`, [id]);
    },
    async deleteByLoop(loopId) {
      await q(`DELETE FROM loop_ship_grants WHERE ${MINE} AND loop_id = $1`, [loopId]);
    },
    close,
  };
}

export function createMemoryShipGrantRows(): ShipGrantRows {
  const rows = createMemoryRows<ShipGrant>();
  return {
    async insertIfAbsent(grant) {
      rows.insertIfAbsent(grant);
      return rows.get(grant.id) ?? grant;
    },
    get: async (id) => rows.get(id),
    byLoop: async (loopId) => rows.where((grant) => grant.loopId === loopId),
    update: async (id, apply) => rows.update(id, apply),
    delete: async (id) => rows.delete(id),
    async deleteByLoop(loopId) {
      for (const grant of rows.where((candidate) => candidate.loopId === loopId)) rows.delete(grant.id);
    },
  };
}
