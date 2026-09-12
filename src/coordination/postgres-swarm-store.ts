import { createPgPool, withPgTransaction, type PoolClient, type Rows } from "../persistence/pg-pool.ts";
import { PROVISIONING_LEASE_MS, type Swarm, type SwarmMember, type SwarmReservation } from "./types.ts";
import { reservationBusy, reservationRefusal, type ReserveResult, type SwarmStore } from "./swarm-store.ts";

const MIGRATION = {
  id: "coordination/swarms/0001",
  expectedChecksum: "5b0d4c2febad12cdb08eaac2b3d5539ea707e5b5818f95c69b0e5abdc0d21d43",
  statements: [
    `CREATE TABLE IF NOT EXISTS swarms(
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      session_limit INT NOT NULL,
      max_children_per_parent INT NOT NULL,
      max_depth INT NOT NULL,
      sessions_used INT NOT NULL DEFAULT 0,
      stopped_at BIGINT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS swarm_members(
      swarm_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      depth INT NOT NULL,
      children_used INT NOT NULL DEFAULT 0,
      stopped_at BIGINT,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (swarm_id, session_id)
    )`,
    `CREATE TABLE IF NOT EXISTS swarm_reservations(
      swarm_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      n INT NOT NULL,
      session_ids TEXT[] NOT NULL DEFAULT '{}',
      lease_expires_at BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (swarm_id, request_id)
    )`,
  ],
};

function rowToSwarm(row: Record<string, unknown>): Swarm {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    rootSessionId: row.root_session_id as string,
    sessionLimit: Number(row.session_limit),
    maxChildrenPerParent: Number(row.max_children_per_parent),
    maxDepth: Number(row.max_depth),
    sessionsUsed: Number(row.sessions_used),
    stoppedAt: row.stopped_at === null ? null : Number(row.stopped_at),
    createdAt: Number(row.created_at),
  };
}

function rowToMember(row: Record<string, unknown>): SwarmMember {
  return {
    swarmId: row.swarm_id as string,
    sessionId: row.session_id as string,
    parentSessionId: (row.parent_session_id as string | null) ?? null,
    depth: Number(row.depth),
    childrenUsed: Number(row.children_used),
    stoppedAt: row.stopped_at === null ? null : Number(row.stopped_at),
    createdAt: Number(row.created_at),
  };
}

function rowToReservation(row: Record<string, unknown>): SwarmReservation {
  return {
    swarmId: row.swarm_id as string,
    requestId: row.request_id as string,
    parentSessionId: row.parent_session_id as string,
    n: Number(row.n),
    slots: (row.session_ids as (string | null)[] | null) ?? [],
    leaseExpiresAt: Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
  };
}

export function createPostgresSwarmStore(connectionString: string): SwarmStore {
  const pg = createPgPool(connectionString, [MIGRATION]);
  const q = (text: string, params?: unknown[]): Promise<Rows> => pg.q(text, params);
  const tx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withPgTransaction(await pg.pool(), fn);

  return {
    async createSwarm(input) {
      return tx(async (client) => {
        const created = await client.query(
          `INSERT INTO swarms(id, scope_id, root_session_id, session_limit, max_children_per_parent, max_depth,
                              sessions_used, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7) RETURNING *`,
          [
            input.id,
            input.scopeId,
            input.rootSessionId,
            input.sessionLimit,
            input.maxChildrenPerParent,
            input.maxDepth,
            input.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO swarm_members(swarm_id, session_id, parent_session_id, depth, children_used, created_at)
           VALUES ($1, $2, NULL, 0, 0, $3)`,
          [input.id, input.rootSessionId, input.createdAt],
        );
        return rowToSwarm(created.rows[0]!);
      });
    },
    async getSwarm(swarmId) {
      const rows = await q(`SELECT * FROM swarms WHERE id = $1`, [swarmId]);
      return rows[0] ? rowToSwarm(rows[0]) : null;
    },
    async getMember(swarmId, sessionId) {
      const rows = await q(`SELECT * FROM swarm_members WHERE swarm_id = $1 AND session_id = $2`, [swarmId, sessionId]);
      return rows[0] ? rowToMember(rows[0]) : null;
    },
    async members(swarmId) {
      const rows = await q(`SELECT * FROM swarm_members WHERE swarm_id = $1 ORDER BY created_at ASC, session_id ASC`, [
        swarmId,
      ]);
      return rows.map(rowToMember);
    },
    async reserve(input) {
      return tx(async (client): Promise<ReserveResult> => {
        const locked = await client.query(`SELECT * FROM swarms WHERE id = $1 FOR UPDATE`, [input.swarmId]);
        if (!locked.rows[0]) return { ok: false, reason: "unknown_swarm" };
        const swarm = rowToSwarm(locked.rows[0]);
        const replay = await client.query(`SELECT * FROM swarm_reservations WHERE swarm_id = $1 AND request_id = $2`, [
          input.swarmId,
          input.requestId,
        ]);
        if (replay.rows[0]) {
          const existing = rowToReservation(replay.rows[0]);
          if (reservationBusy(existing, input.createdAt)) return { ok: false, reason: "provisioning_in_progress" };
          const leased = await client.query(
            `UPDATE swarm_reservations SET lease_expires_at = $3 WHERE swarm_id = $1 AND request_id = $2 RETURNING *`,
            [input.swarmId, input.requestId, input.createdAt + PROVISIONING_LEASE_MS],
          );
          return { ok: true, reservation: rowToReservation(leased.rows[0]!), replay: true };
        }
        const parentRow = await client.query(`SELECT * FROM swarm_members WHERE swarm_id = $1 AND session_id = $2`, [
          input.swarmId,
          input.parentSessionId,
        ]);
        const parent = parentRow.rows[0] ? rowToMember(parentRow.rows[0]) : null;
        const refusal = reservationRefusal(swarm, parent, input.n);
        if (refusal) return { ok: false, reason: refusal };
        await client.query(`UPDATE swarms SET sessions_used = sessions_used + $2 WHERE id = $1`, [
          input.swarmId,
          input.n,
        ]);
        await client.query(
          `UPDATE swarm_members SET children_used = children_used + $3 WHERE swarm_id = $1 AND session_id = $2`,
          [input.swarmId, input.parentSessionId, input.n],
        );
        const inserted = await client.query(
          `INSERT INTO swarm_reservations(swarm_id, request_id, parent_session_id, n, session_ids,
                                          lease_expires_at, created_at)
           VALUES ($1, $2, $3, $4, array_fill(NULL::text, ARRAY[$4::int]), $5, $6) RETURNING *`,
          [
            input.swarmId,
            input.requestId,
            input.parentSessionId,
            input.n,
            input.createdAt + PROVISIONING_LEASE_MS,
            input.createdAt,
          ],
        );
        return { ok: true, reservation: rowToReservation(inserted.rows[0]!), replay: false };
      });
    },
    async getReservation(swarmId, requestId) {
      const rows = await q(`SELECT * FROM swarm_reservations WHERE swarm_id = $1 AND request_id = $2`, [
        swarmId,
        requestId,
      ]);
      return rows[0] ? rowToReservation(rows[0]) : null;
    },
    async appendChild(input) {
      await tx(async (client) => {
        await client.query(
          `INSERT INTO swarm_members(swarm_id, session_id, parent_session_id, depth, children_used, created_at)
           VALUES ($1, $2, $3, $4, 0, $5) ON CONFLICT (swarm_id, session_id) DO NOTHING`,
          [input.swarmId, input.childSessionId, input.parentSessionId, input.depth, input.createdAt],
        );
        await client.query(
          `UPDATE swarm_reservations SET session_ids[$4] = $3 WHERE swarm_id = $1 AND request_id = $2`,
          [input.swarmId, input.requestId, input.childSessionId, input.slot + 1],
        );
      });
    },
    async settleFailure(swarmId, requestId, discardedSessionIds) {
      await tx(async (client) => {
        await client.query(`SELECT id FROM swarms WHERE id = $1 FOR UPDATE`, [swarmId]);
        const held = await client.query(`SELECT * FROM swarm_reservations WHERE swarm_id = $1 AND request_id = $2`, [
          swarmId,
          requestId,
        ]);
        if (!held.rows[0]) return;
        const reservation = rowToReservation(held.rows[0]);
        const discarded = [...discardedSessionIds];
        await client.query(`DELETE FROM swarm_members WHERE swarm_id = $1 AND session_id = ANY($2::text[])`, [
          swarmId,
          discarded,
        ]);
        const kept = reservation.slots.map((id) => (id !== null && discarded.includes(id) ? null : id));
        if (kept.some((id) => id !== null)) {
          await client.query(
            `UPDATE swarm_reservations SET session_ids = $3::text[], lease_expires_at = 0
               WHERE swarm_id = $1 AND request_id = $2`,
            [swarmId, requestId, kept],
          );
          return;
        }
        await client.query(`UPDATE swarms SET sessions_used = sessions_used - $2 WHERE id = $1`, [
          swarmId,
          reservation.n,
        ]);
        await client.query(
          `UPDATE swarm_members SET children_used = children_used - $3 WHERE swarm_id = $1 AND session_id = $2`,
          [swarmId, reservation.parentSessionId, reservation.n],
        );
        await client.query(`DELETE FROM swarm_reservations WHERE swarm_id = $1 AND request_id = $2`, [
          swarmId,
          requestId,
        ]);
      });
    },
    async markStopped(swarmId, sessionIds, at, wholeSwarm) {
      await tx(async (client) => {
        await client.query(
          `UPDATE swarm_members SET stopped_at = $3
             WHERE swarm_id = $1 AND session_id = ANY($2::text[]) AND stopped_at IS NULL`,
          [swarmId, [...sessionIds], at],
        );
        if (wholeSwarm) {
          await client.query(`UPDATE swarms SET stopped_at = $2 WHERE id = $1 AND stopped_at IS NULL`, [swarmId, at]);
        }
      });
    },
    close: () => pg.close(),
  };
}
