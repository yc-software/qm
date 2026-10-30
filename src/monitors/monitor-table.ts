import type { Monitor } from "../types.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { boundTenant } from "../tenants/context.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type TenantMonitor = Monitor & { tenantId: string | undefined };

export interface MonitorRows {
  insert(monitor: Monitor): Promise<void>;
  get(id: string): Promise<Monitor | null>;
  ownedBy(scopeId: string): Promise<Monitor[]>;
  watching(threadRefs: readonly string[]): Promise<Monitor[]>;
  update(id: string, apply: (monitor: Monitor) => Monitor): Promise<Monitor | null>;
  delete(id: string): Promise<void>;
  enabled(): Promise<TenantMonitor[]>;
  deleteDisabledBefore(cutoff: number): Promise<number>;
}

const COLUMNS = `id, owner_scope_id, owner, created_by, owner_consented_at, destination, enabled, created_at,
  last_fired_at, process_id, command, purpose, thread_ref, instructions, pattern, cursor, tail, expires_at, last_error`;

const VALUES = "$1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19";

const SELECT = `SELECT tenant_id::text AS tenant_id, ${COLUMNS} FROM monitors`;

const LAST_ACTIVITY = "GREATEST(expires_at, COALESCE(last_fired_at, 0), created_at)";

const text = (value: string | undefined): string | null => (value === undefined ? null : pgTextSafe(value));

function monitorParams(m: Monitor): unknown[] {
  return [
    m.id,
    m.ownerScopeId,
    m.owner,
    m.createdBy,
    m.ownerConsentedAt ?? null,
    m.destination === undefined ? null : jsonbStringify(m.destination),
    m.enabled,
    m.createdAt,
    m.lastFiredAt ?? null,
    m.processId,
    pgTextSafe(m.command),
    text(m.purpose),
    m.threadRef,
    text(m.instructions),
    text(m.pattern),
    m.cursor,
    text(m.tail),
    m.expiresAt,
    text(m.lastError),
  ];
}

const epoch = (value: unknown): number | undefined => (value === null ? undefined : Number(value));

function rowToMonitor(r: Record<string, unknown>): Monitor {
  const monitor: Monitor = {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as Monitor["ownerScopeId"],
    owner: r.owner as string,
    createdBy: r.created_by as string,
    ownerConsentedAt: epoch(r.owner_consented_at),
    destination: (r.destination ?? undefined) as Monitor["destination"],
    enabled: r.enabled as boolean,
    createdAt: Number(r.created_at),
    lastFiredAt: epoch(r.last_fired_at),
    processId: r.process_id as string,
    command: r.command as string,
    purpose: (r.purpose ?? undefined) as string | undefined,
    threadRef: r.thread_ref as string,
    instructions: (r.instructions ?? undefined) as string | undefined,
    pattern: (r.pattern ?? undefined) as string | undefined,
    cursor: Number(r.cursor),
    tail: (r.tail ?? undefined) as string | undefined,
    expiresAt: Number(r.expires_at),
    lastError: (r.last_error ?? undefined) as string | undefined,
  };
  for (const key of Object.keys(monitor) as Array<keyof Monitor>) if (monitor[key] === undefined) delete monitor[key];
  return monitor;
}

export const MONITORS_MIGRATION = keyValueConversion({
  table: "monitors",
  columns: [
    "id TEXT NOT NULL",
    "owner_scope_id TEXT NOT NULL",
    "owner TEXT NOT NULL",
    "created_by TEXT NOT NULL",
    "owner_consented_at BIGINT",
    "destination JSONB",
    "enabled BOOLEAN NOT NULL",
    "created_at BIGINT NOT NULL",
    "last_fired_at BIGINT",
    "process_id TEXT NOT NULL",
    "command TEXT NOT NULL",
    "purpose TEXT",
    "thread_ref TEXT NOT NULL",
    "instructions TEXT",
    "pattern TEXT",
    "cursor BIGINT NOT NULL",
    "tail TEXT",
    "expires_at BIGINT NOT NULL",
    "last_error TEXT",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    owner_scope_id: "json->>'ownerScopeId'",
    owner: "json->>'owner'",
    created_by: "json->>'createdBy'",
    owner_consented_at: "(json->>'ownerConsentedAt')::numeric::bigint",
    destination: "NULLIF(json->'destination', 'null'::jsonb)",
    enabled: "(json->>'enabled')::boolean",
    created_at: "(json->>'createdAt')::numeric::bigint",
    last_fired_at: "(json->>'lastFiredAt')::numeric::bigint",
    process_id: "json->>'processId'",
    command: "json->>'command'",
    purpose: "json->>'purpose'",
    thread_ref: "json->>'threadRef'",
    instructions: "json->>'instructions'",
    pattern: "json->>'pattern'",
    cursor: "COALESCE((json->>'cursor')::numeric::bigint, 0)",
    tail: "json->>'tail'",
    expires_at: "(json->>'expiresAt')::numeric::bigint",
    last_error: "json->>'lastError'",
  },
  indexes: [
    "CREATE INDEX monitors_by_owner_scope ON monitors(tenant_id, owner_scope_id)",
    "CREATE INDEX monitors_by_thread_ref ON monitors(tenant_id, thread_ref) WHERE enabled",
    "CREATE INDEX monitors_enabled ON monitors(created_at) WHERE enabled",
    `CREATE INDEX monitors_disabled ON monitors((${LAST_ACTIVITY})) WHERE NOT enabled`,
  ],
});

export function createPostgresMonitorRows(connectionString: string): MonitorRows {
  const { q, query, pool } = createPgPool(connectionString, [MONITORS_MIGRATION]);
  const many = async (sql: string, params: unknown[] = []) => (await q(sql, params)).map(rowToMonitor);
  return {
    async insert(monitor) {
      await q(`INSERT INTO monitors(${COLUMNS}) VALUES (${VALUES})`, monitorParams(monitor));
    },
    async get(id) {
      return (await many(`${SELECT} WHERE tenant_id = qm_tenant_id() AND id = $1`, [id]))[0] ?? null;
    },
    ownedBy: (scopeId) =>
      many(`${SELECT} WHERE tenant_id = qm_tenant_id() AND owner_scope_id = $1 ORDER BY id`, [scopeId]),
    async watching(threadRefs) {
      if (!threadRefs.length) return [];
      return many(
        `${SELECT} WHERE tenant_id = qm_tenant_id() AND enabled AND thread_ref = ANY($1::text[]) ORDER BY id`,
        [[...threadRefs]],
      );
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE tenant_id = qm_tenant_id() AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(rowToMonitor(current.rows[0])), id };
        await client.query(
          `UPDATE monitors SET (${COLUMNS}) = (${VALUES}) WHERE tenant_id = qm_tenant_id() AND id = $1`,
          monitorParams(next),
        );
        return next;
      });
    },
    async delete(id) {
      await q(`DELETE FROM monitors WHERE tenant_id = qm_tenant_id() AND id = $1`, [id]);
    },
    async enabled() {
      const rows = await q(`${SELECT} WHERE enabled ORDER BY created_at, tenant_id, id`);
      return rows.map((r) => ({ ...rowToMonitor(r), tenantId: r.tenant_id as string }));
    },
    async deleteDisabledBefore(cutoff) {
      return (await query(`DELETE FROM monitors WHERE NOT enabled AND ${LAST_ACTIVITY} <= $1`, [cutoff])).rowCount;
    },
  };
}

export function createMemoryMonitorRows(): MonitorRows {
  const rows = new Map<string, { monitor: Monitor; tenantId: string | undefined }>();
  const all = (): Monitor[] =>
    [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => structuredClone(row.monitor));
  return {
    async insert(monitor) {
      rows.set(monitor.id, { monitor: structuredClone(monitor), tenantId: boundTenant() });
    },
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row.monitor) : null;
    },
    async ownedBy(scopeId) {
      return all().filter((m) => m.ownerScopeId === scopeId);
    },
    async watching(threadRefs) {
      const refs = new Set(threadRefs);
      return all().filter((m) => m.enabled && refs.has(m.threadRef));
    },
    async update(id, apply) {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...apply(structuredClone(row.monitor)), id };
      row.monitor = structuredClone(next);
      return next;
    },
    async delete(id) {
      rows.delete(id);
    },
    async enabled() {
      return [...rows.values()]
        .filter((row) => row.monitor.enabled)
        .map((row) => ({ ...structuredClone(row.monitor), tenantId: row.tenantId }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async deleteDisabledBefore(cutoff) {
      let deleted = 0;
      for (const [id, { monitor: m }] of rows) {
        if (m.enabled || Math.max(m.expiresAt, m.lastFiredAt ?? 0, m.createdAt) > cutoff) continue;
        rows.delete(id);
        deleted++;
      }
      return deleted;
    },
  };
}
