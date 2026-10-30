import type { IngressDelivery, LoopIngress } from "./ingress.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { createMemoryRows } from "./memory-rows.ts";
import { columnList, json, kvBigint, kvJsonb, kvTexts, num, present, text, texts, type Row } from "./pg-values.ts";

type TenantIngress = LoopIngress & { tenantId: string };

export interface IngressSourceRows {
  get(id: string): Promise<LoopIngress | null>;
  byLoop(loopId: string): Promise<LoopIngress[]>;
  insert(source: LoopIngress): Promise<void>;
  update(id: string, apply: (source: LoopIngress) => LoopIngress): Promise<LoopIngress | null>;
  enabled(): Promise<TenantIngress[]>;
  tenantOf(id: string): Promise<string | null>;
  gmailWatching(email: string): Promise<TenantIngress[]>;
  close?(): Promise<void>;
}

export interface IngressDeliveryRows {
  insertIfAbsent(delivery: IngressDelivery): Promise<void>;
  pending(queueKey: string, now: number, limit: number): Promise<IngressDelivery[]>;
  update(id: string, apply: (delivery: IngressDelivery) => IngressDelivery): Promise<IngressDelivery | null>;
  pruneCompleted(before: number): Promise<number>;
  close?(): Promise<void>;
}

const LOOP_INGRESS_MIGRATION = typedTableMigration({
  table: "loop_ingress",
  columns: [
    "id TEXT NOT NULL",
    "loop_id TEXT NOT NULL",
    "owner TEXT NOT NULL",
    "kind TEXT NOT NULL",
    "enabled BOOLEAN NOT NULL",
    "secret TEXT",
    "team_id TEXT",
    "channels TEXT[]",
    "gmail JSONB",
    "created_at BIGINT NOT NULL",
    "last_received_at BIGINT",
    "last_error TEXT",
    "next_watch_at BIGINT",
    "next_reconcile_at BIGINT",
    "next_work_at BIGINT",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    loop_id: "json->>'loopId'",
    owner: "json->>'owner'",
    kind: "json->>'kind'",
    enabled: "COALESCE((json->>'enabled')::boolean, false)",
    secret: "json->>'secret'",
    team_id: "json->>'teamId'",
    channels: kvTexts("channels"),
    gmail: kvJsonb("gmail"),
    created_at: `COALESCE(${kvBigint("createdAt")}, 0)`,
    last_received_at: kvBigint("lastReceivedAt"),
    last_error: "json->>'lastError'",
    next_watch_at: kvBigint("nextWatchAt"),
    next_reconcile_at: kvBigint("nextReconcileAt"),
    next_work_at: kvBigint("nextWorkAt"),
  },
  where: "json->>'loopId' IS NOT NULL AND json->>'owner' IS NOT NULL AND json->>'kind' IS NOT NULL",
  indexes: [
    "CREATE INDEX loop_ingress_by_loop ON loop_ingress(tenant_id, loop_id, kind)",
    "CREATE INDEX loop_ingress_by_id ON loop_ingress(id)",
    "CREATE INDEX loop_ingress_enabled ON loop_ingress(kind) WHERE enabled",
    "CREATE INDEX loop_ingress_gmail ON loop_ingress((gmail->>'email')) WHERE enabled AND kind = 'gmail'",
  ],
});

const LOOP_INGRESS_DELIVERIES_MIGRATION = typedTableMigration({
  table: "loop_ingress_deliveries",
  columns: [
    "id TEXT NOT NULL",
    "ingress_id TEXT NOT NULL",
    "queue_key TEXT",
    "received_at BIGINT NOT NULL",
    "entries JSONB",
    "history_id TEXT",
    "ingested BOOLEAN",
    "completed_at BIGINT",
    "attempts INTEGER NOT NULL",
    "next_attempt_at BIGINT NOT NULL",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    ingress_id: "json->>'ingressId'",
    queue_key: "json->>'queueKey'",
    received_at: `COALESCE(${kvBigint("receivedAt")}, 0)`,
    entries: kvJsonb("entries"),
    history_id: "json->>'historyId'",
    ingested: "(json->>'ingested')::boolean",
    completed_at: kvBigint("completedAt"),
    attempts: "COALESCE((json->>'attempts')::integer, 0)",
    next_attempt_at: `COALESCE(${kvBigint("nextAttemptAt")}, 0)`,
  },
  where: "json->>'ingressId' IS NOT NULL",
  indexes: [
    `CREATE INDEX loop_ingress_deliveries_pending ON loop_ingress_deliveries(tenant_id, queue_key, received_at)
       WHERE queue_key IS NOT NULL AND completed_at IS NULL`,
    `CREATE INDEX loop_ingress_deliveries_completed ON loop_ingress_deliveries(completed_at)
       WHERE completed_at IS NOT NULL`,
  ],
});

const SOURCE = columnList([
  ["id", "text"],
  ["loop_id", "text"],
  ["owner", "text"],
  ["kind", "text"],
  ["enabled", "boolean"],
  ["secret", "text"],
  ["team_id", "text"],
  ["channels", "text[]"],
  ["gmail", "jsonb"],
  ["created_at", "bigint"],
  ["last_received_at", "bigint"],
  ["last_error", "text"],
  ["next_watch_at", "bigint"],
  ["next_reconcile_at", "bigint"],
  ["next_work_at", "bigint"],
]);

const DELIVERY = columnList([
  ["id", "text"],
  ["ingress_id", "text"],
  ["queue_key", "text"],
  ["received_at", "bigint"],
  ["entries", "jsonb"],
  ["history_id", "text"],
  ["ingested", "boolean"],
  ["completed_at", "bigint"],
  ["attempts", "integer"],
  ["next_attempt_at", "bigint"],
]);

const SELECT_SOURCE = `SELECT tenant_id::text AS tenant_id, ${SOURCE.names} FROM loop_ingress`;

const SELECT_DELIVERY = `SELECT ${DELIVERY.names} FROM loop_ingress_deliveries`;

const MINE = `tenant_id = ${TENANT}`;

function sourceParams(source: LoopIngress): unknown[] {
  return [
    source.id,
    text(source.loopId),
    text(source.owner),
    source.kind,
    source.enabled,
    text(source.secret),
    text(source.teamId),
    texts(source.channels),
    json(source.gmail),
    source.createdAt,
    source.lastReceivedAt ?? null,
    text(source.lastError),
    source.nextWatchAt ?? null,
    source.nextReconcileAt ?? null,
    source.nextWorkAt ?? null,
  ];
}

function sourceFromRow(r: Row): LoopIngress {
  return present<LoopIngress>({
    id: r.id,
    loopId: r.loop_id,
    owner: r.owner,
    kind: r.kind,
    enabled: r.enabled,
    secret: r.secret,
    teamId: r.team_id,
    channels: r.channels,
    gmail: r.gmail,
    createdAt: num(r.created_at),
    lastReceivedAt: num(r.last_received_at),
    lastError: r.last_error,
    nextWatchAt: num(r.next_watch_at),
    nextReconcileAt: num(r.next_reconcile_at),
    nextWorkAt: num(r.next_work_at),
  });
}

const tenantSource = (r: Row): TenantIngress => ({ ...sourceFromRow(r), tenantId: r.tenant_id as string });

function deliveryParams(delivery: IngressDelivery): unknown[] {
  return [
    delivery.id,
    text(delivery.ingressId),
    text(delivery.queueKey),
    delivery.receivedAt,
    json(delivery.entries),
    text(delivery.historyId),
    delivery.ingested ?? null,
    delivery.completedAt ?? null,
    delivery.attempts,
    delivery.nextAttemptAt,
  ];
}

function deliveryFromRow(r: Row): IngressDelivery {
  return present<IngressDelivery>({
    id: r.id,
    ingressId: r.ingress_id,
    queueKey: r.queue_key,
    receivedAt: num(r.received_at),
    entries: r.entries,
    historyId: r.history_id,
    ingested: r.ingested,
    completedAt: num(r.completed_at),
    attempts: r.attempts,
    nextAttemptAt: num(r.next_attempt_at),
  });
}

export function createPostgresIngressSourceRows(connectionString: string): IngressSourceRows {
  const { q, pool, close } = createPgPool(connectionString, [TENANCY_BASE, LOOP_INGRESS_MIGRATION]);
  return {
    async get(id) {
      const rows = await q(`${SELECT_SOURCE} WHERE ${MINE} AND id = $1`, [id]);
      return rows[0] ? sourceFromRow(rows[0]) : null;
    },
    async byLoop(loopId) {
      return (await q(`${SELECT_SOURCE} WHERE ${MINE} AND loop_id = $1 ORDER BY id`, [loopId])).map(sourceFromRow);
    },
    async insert(source) {
      await q(`INSERT INTO loop_ingress(${SOURCE.names}) VALUES (${SOURCE.values})`, sourceParams(source));
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT_SOURCE} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(sourceFromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loop_ingress SET (${SOURCE.names}) = ROW(${SOURCE.values}) WHERE ${MINE} AND id = $1`,
          sourceParams(next),
        );
        return present<LoopIngress>(next as unknown as Row);
      });
    },
    async enabled() {
      return (await q(`${SELECT_SOURCE} WHERE enabled ORDER BY tenant_id, id`)).map(tenantSource);
    },
    async tenantOf(id) {
      const rows = await q(
        `SELECT tenant_id::text AS tenant_id FROM loop_ingress WHERE id = $1 ORDER BY tenant_id LIMIT 1`,
        [id],
      );
      return (rows[0]?.tenant_id as string | undefined) ?? null;
    },
    async gmailWatching(email) {
      const rows = await q(
        `${SELECT_SOURCE} WHERE enabled AND kind = 'gmail' AND gmail->>'email' = $1 ORDER BY tenant_id, id`,
        [email],
      );
      return rows.map(tenantSource);
    },
    close,
  };
}

export function createPostgresIngressDeliveryRows(connectionString: string): IngressDeliveryRows {
  const { q, query, pool, close } = createPgPool(connectionString, [TENANCY_BASE, LOOP_INGRESS_DELIVERIES_MIGRATION]);
  return {
    async insertIfAbsent(delivery) {
      await q(
        `INSERT INTO loop_ingress_deliveries(${DELIVERY.names}) VALUES (${DELIVERY.values})
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        deliveryParams(delivery),
      );
    },
    async pending(queueKey, now, limit) {
      const rows = await q(
        `${SELECT_DELIVERY} WHERE ${MINE} AND queue_key = $1 AND completed_at IS NULL AND next_attempt_at <= $2
         ORDER BY received_at, id LIMIT $3`,
        [queueKey, now, limit],
      );
      return rows.map(deliveryFromRow);
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT_DELIVERY} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(deliveryFromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loop_ingress_deliveries SET (${DELIVERY.names}) = ROW(${DELIVERY.values}) WHERE ${MINE} AND id = $1`,
          deliveryParams(next),
        );
        return present<IngressDelivery>(next as unknown as Row);
      });
    },
    async pruneCompleted(before) {
      return (await query(`DELETE FROM loop_ingress_deliveries WHERE completed_at < $1`, [before])).rowCount;
    },
    close,
  };
}

export function createMemoryIngressSourceRows(): IngressSourceRows {
  const rows = createMemoryRows<LoopIngress>();
  return {
    get: async (id) => rows.get(id),
    byLoop: async (loopId) => rows.where((source) => source.loopId === loopId),
    async insert(source) {
      if (!rows.insertIfAbsent(source)) throw new Error(`loop ingress ${source.id} already exists`);
    },
    update: async (id, apply) => rows.update(id, apply),
    enabled: async () => rows.acrossTenants((source) => source.enabled),
    tenantOf: async (id) => rows.acrossTenants((source) => source.id === id)[0]?.tenantId ?? null,
    gmailWatching: async (email) =>
      rows.acrossTenants((source) => source.enabled && source.kind === "gmail" && source.gmail?.email === email),
  };
}

export function createMemoryIngressDeliveryRows(): IngressDeliveryRows {
  const rows = createMemoryRows<IngressDelivery>();
  return {
    insertIfAbsent: async (delivery) => void rows.insertIfAbsent(delivery),
    pending: async (queueKey, now, limit) =>
      rows
        .where((delivery) => delivery.queueKey === queueKey && !delivery.completedAt && delivery.nextAttemptAt <= now)
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, limit),
    update: async (id, apply) => rows.update(id, apply),
    pruneCompleted: async (before) =>
      rows.purgeAcrossTenants((delivery) => delivery.completedAt !== undefined && delivery.completedAt < before),
  };
}
