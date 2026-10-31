import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { currentTenant } from "../tenants/context.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { jsonbStringify } from "../util/text.ts";
import { assertSwarmRun, type SwarmRunFence } from "./swarm-fence.ts";
import type { SwarmStorage } from "./swarm-store.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";

export type TenantSwarmStorage = SwarmStorage & { tenantId: string };

export interface SwarmRows {
  get(id: string): Promise<SwarmStorage | null>;
  write(
    id: string,
    mutate: (current: SwarmStorage | null) => SwarmStorage,
    fence?: SwarmRunFence,
  ): Promise<SwarmStorage>;
  pending(afterId: string | undefined, limit: number): Promise<TenantSwarmStorage[]>;
  close?(): Promise<void>;
}

export const SWARMS_MIGRATION = typedTableMigration({
  table: "swarms",
  columns: [
    "id TEXT NOT NULL",
    "scope_id TEXT NOT NULL",
    "owner_id TEXT NOT NULL",
    "participants TEXT[] NOT NULL",
    "created_at BIGINT NOT NULL",
    "expires_at BIGINT",
    "template JSONB NOT NULL",
    "settings JSONB NOT NULL",
    "backend TEXT NOT NULL",
    "board JSONB",
    "members JSONB NOT NULL",
    "messages JSONB NOT NULL",
    "spawn_requests JSONB NOT NULL",
    "message_requests JSONB NOT NULL",
    "notification_count BIGINT NOT NULL",
    "pending BOOLEAN NOT NULL",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    scope_id: "json->>'scopeId'",
    owner_id: "json->>'ownerId'",
    participants: "ARRAY(SELECT jsonb_array_elements_text(COALESCE(json->'participants', '[]')))",
    created_at: "COALESCE((json->>'createdAt')::numeric::bigint, 0)",
    expires_at: "(json->>'expiresAt')::numeric::bigint",
    template: "json->'template'",
    settings: "json->'settings'",
    backend: "json->>'backend'",
    board: "NULLIF(json->'board', 'null')",
    members: "COALESCE(json->'members', '[]')",
    messages: "COALESCE(json->'messages', '[]')",
    spawn_requests: "COALESCE(json->'spawnRequests', '{}')",
    message_requests: "COALESCE(json->'messageRequests', '{}')",
    notification_count: "COALESCE((json->>'notificationCount')::numeric::bigint, 0)",
    pending: "COALESCE((json->>'pending')::boolean, false)",
  },
  where:
    "json ? 'scopeId' AND json ? 'ownerId' AND json ? 'backend' AND jsonb_typeof(json->'template') = 'object' AND jsonb_typeof(json->'settings') = 'object'",
  indexes: ["CREATE INDEX swarms_pending_claim ON swarms(id) WHERE pending"],
});

const COLUMNS =
  "id, scope_id, owner_id, participants, created_at, expires_at, template, settings, backend, board, members, messages, spawn_requests, message_requests, notification_count, pending";
const VALUES =
  "$1, $2, $3, $4::text[], $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16";
const MINE = `tenant_id = ${TENANT}`;

function swarmParams(swarm: SwarmStorage): unknown[] {
  return [
    swarm.id,
    swarm.scopeId,
    swarm.ownerId,
    swarm.participants,
    swarm.createdAt,
    swarm.expiresAt ?? null,
    jsonbStringify(swarm.template),
    jsonbStringify(swarm.settings),
    swarm.backend,
    swarm.board ? jsonbStringify(swarm.board) : null,
    jsonbStringify(swarm.members),
    jsonbStringify(swarm.messages),
    jsonbStringify(swarm.spawnRequests),
    jsonbStringify(swarm.messageRequests),
    swarm.notificationCount,
    swarm.pending,
  ];
}

function swarmFromRow(row: Record<string, unknown>): SwarmStorage {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    ownerId: row.owner_id as string,
    participants: row.participants as string[],
    createdAt: Number(row.created_at),
    ...(row.expires_at === null ? {} : { expiresAt: Number(row.expires_at) }),
    template: row.template as SwarmStorage["template"],
    settings: row.settings as SwarmStorage["settings"],
    backend: row.backend as SwarmStorage["backend"],
    ...(row.board === null ? {} : { board: row.board as NonNullable<SwarmStorage["board"]> }),
    members: row.members as SwarmStorage["members"],
    messages: row.messages as SwarmStorage["messages"],
    spawnRequests: row.spawn_requests as SwarmStorage["spawnRequests"],
    messageRequests: row.message_requests as SwarmStorage["messageRequests"],
    notificationCount: Number(row.notification_count),
    pending: row.pending as boolean,
  };
}

async function fenceRun(client: PoolClient, fence: SwarmRunFence): Promise<Run | null> {
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const result = await client.query<Run>(
    `SELECT status, attempts, lease_token AS "leaseToken", lease_expires_at::double precision AS "leaseExpiresAt", session_id AS "sessionId", request::jsonb AS request FROM runs WHERE id=$1 FOR UPDATE`,
    [fence.runId],
  );
  const run = result.rows[0] ?? null;
  assertSwarmRun(fence, run);
  const session = await client.query(
    "SELECT id FROM sessions WHERE tenant_id = qm_tenant_id() AND id=$1 AND scope_id=$2 AND thread_ref=$3 FOR SHARE",
    [fence.sessionId, fence.scopeId, fence.threadRef],
  );
  if (!session.rowCount) throw new Error("capability session mismatch");
  return run;
}

async function upsert(
  client: PoolClient,
  id: string,
  mutate: (current: SwarmStorage | null) => SwarmStorage,
): Promise<SwarmStorage> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await client.query(`SELECT ${COLUMNS} FROM swarms WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    const next = { ...mutate(row ? swarmFromRow(row) : null), id };
    if (row) {
      await client.query(`UPDATE swarms SET (${COLUMNS}) = (${VALUES}) WHERE ${MINE} AND id = $1`, swarmParams(next));
      return next;
    }
    const inserted = await client.query(
      `INSERT INTO swarms(${COLUMNS}) VALUES (${VALUES}) ON CONFLICT (tenant_id, id) DO NOTHING`,
      swarmParams(next),
    );
    if (inserted.rowCount) return next;
  }
  throw new Error("swarm write conflict");
}

export function createPostgresSwarmRows(connectionString: string): SwarmRows {
  const db = createPgPool(connectionString, [TENANCY_BASE, SWARMS_MIGRATION]);
  const { q, pool, close } = db;
  return {
    async get(id) {
      const rows = await q(`SELECT ${COLUMNS} FROM swarms WHERE ${MINE} AND id = $1`, [id]);
      return rows[0] ? swarmFromRow(rows[0]) : null;
    },
    async write(id, mutate, fence) {
      return withPgTransaction(await pool(), async (client) => {
        const run = fence ? await fenceRun(client, fence) : null;
        const next = await upsert(client, id, mutate);
        if (fence) assertSwarmRun(fence, run);
        return next;
      });
    },
    async pending(afterId, limit) {
      const rows = await claimAcrossTenants(
        db,
        `SELECT tenant_id::text AS tenant_id, ${COLUMNS} FROM swarms
          WHERE pending AND ($1::text IS NULL OR id > $1) ORDER BY id LIMIT $2`,
        [afterId ?? null, limit],
      );
      return rows.map((row) => ({ ...swarmFromRow(row), tenantId: row.tenant_id as string }));
    },
    close,
  };
}

export function createMemorySwarmRows(authority?: {
  runs: Pick<RunStore, "get">;
  sessions: Pick<SessionStore, "get">;
}): SwarmRows {
  const tenants = new Map<string, Map<string, SwarmStorage>>();
  const mine = (): Map<string, SwarmStorage> => {
    const tenant = currentTenant();
    if (!tenants.has(tenant)) tenants.set(tenant, new Map());
    return tenants.get(tenant)!;
  };
  const stored = (swarm: SwarmStorage) =>
    structuredClone(Object.fromEntries(Object.entries(swarm).filter(([, value]) => value != null))) as SwarmStorage;
  return {
    async get(id) {
      const swarm = mine().get(id);
      return swarm ? structuredClone(swarm) : null;
    },
    async write(id, mutate, fence) {
      const swarms = mine();
      let run: Run | null = null;
      if (fence) {
        if (!authority) throw new Error("swarm run validation unavailable");
        const session = await authority.sessions.get(fence.sessionId);
        if (!session || session.scopeId !== fence.scopeId || session.threadRef !== fence.threadRef)
          throw new Error("capability session mismatch");
        run = await authority.runs.get(fence.runId);
        assertSwarmRun(fence, run);
      }
      const current = swarms.get(id);
      const next = stored({ ...mutate(current ? structuredClone(current) : null), id });
      if (fence) assertSwarmRun(fence, run);
      swarms.set(id, next);
      return structuredClone(next);
    },
    async pending(afterId, limit) {
      return [...tenants.entries()]
        .flatMap(([tenantId, swarms]) =>
          [...swarms.values()]
            .filter((swarm) => swarm.pending && (afterId === undefined || swarm.id > afterId))
            .map((swarm) => ({ ...structuredClone(swarm), tenantId })),
        )
        .sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)))
        .slice(0, limit);
    },
  };
}
