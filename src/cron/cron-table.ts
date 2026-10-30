import type { Cron } from "../types.ts";
import { createPgPool, withPgTransaction, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { typedColumns } from "../persistence/typed-columns.ts";
import { boundTenant } from "../tenants/context.ts";

export type TenantCron = Cron & { tenantId: string | undefined };

export interface CronRows {
  insertIfAbsent(cron: Cron): Promise<Cron>;
  get(id: string): Promise<Cron | null>;
  list(): Promise<Cron[]>;
  ownedBy(scopeId: string): Promise<Cron[]>;
  tiedTo(threadRefs: readonly string[]): Promise<Cron[]>;
  update(id: string, apply: (cron: Cron) => Cron): Promise<Cron | null>;
  delete(id: string): Promise<void>;
  scheduled(): Promise<TenantCron[]>;
  dueCandidates(now: number): Promise<TenantCron[]>;
}

const CRON = typedColumns<Cron>({
  id: "text",
  ownerScopeId: "text",
  owner: "text",
  createdBy: "text",
  ownerConsentedAt: "bigint",
  destination: "jsonb",
  enabled: "boolean",
  archived: "boolean",
  createdAt: "bigint",
  lastFiredAt: "bigint",
  lastAttemptAt: "bigint",
  nextFireAt: "bigint",
  deferUntil: "bigint",
  runtime: "jsonb",
  schedule: "jsonb",
  title: "text",
  action: "text",
  message: "text",
  loopId: "text",
  unattendedGrants: "text[]",
  sessionRef: "text",
  lastFireNote: "jsonb",
});

const SELECT = `SELECT tenant_id::text AS tenant_id, ${CRON.names} FROM crons`;
const MINE = "tenant_id = qm_tenant_id()";
const rowToCron = (r: Record<string, unknown>): Cron => CRON.fromRow(r);
const tenantRow = (r: Record<string, unknown>): TenantCron => ({ ...CRON.fromRow(r), tenantId: r.tenant_id as string });

export const CRONS_MIGRATION: PgMigrationDefinition = {
  id: "tenancy/crons/0001-typed",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `ALTER TABLE IF EXISTS crons RENAME TO crons_json`,
    `CREATE TABLE crons(
       tenant_id UUID NOT NULL DEFAULT qm_tenant_id() REFERENCES tenants(id),
       id TEXT NOT NULL,
       owner_scope_id TEXT NOT NULL,
       owner TEXT NOT NULL,
       created_by TEXT NOT NULL,
       owner_consented_at BIGINT,
       destination JSONB,
       enabled BOOLEAN NOT NULL,
       archived BOOLEAN,
       created_at BIGINT NOT NULL,
       last_fired_at BIGINT,
       last_attempt_at BIGINT,
       next_fire_at BIGINT,
       defer_until BIGINT,
       runtime JSONB,
       schedule JSONB NOT NULL,
       title TEXT,
       action TEXT,
       message TEXT,
       loop_id TEXT,
       unattended_grants TEXT[],
       session_ref TEXT,
       last_fire_note JSONB,
       PRIMARY KEY (tenant_id, id)
     )`,
    `CREATE INDEX crons_owner_scope ON crons(tenant_id, owner_scope_id)`,
    `CREATE INDEX crons_session_ref ON crons(tenant_id, session_ref) WHERE session_ref IS NOT NULL`,
    `CREATE INDEX crons_destination_target ON crons(tenant_id, (destination->>'target')) WHERE destination IS NOT NULL`,
    `CREATE INDEX crons_scheduled ON crons(next_fire_at) WHERE enabled AND archived IS NOT TRUE`,
    `ALTER TABLE crons ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON crons USING (tenant_id = qm_tenant_id()) WITH CHECK (tenant_id = qm_tenant_id())`,
    `DO $backfill$ BEGIN
       IF to_regclass('crons_json') IS NOT NULL THEN
         INSERT INTO crons(tenant_id, ${CRON.names})
         SELECT (SELECT id FROM tenants), ${CRON.fromJson("old")} FROM crons_json old;
         IF to_regclass('cron_fires') IS NOT NULL THEN
           INSERT INTO cron_fires(cron_id, fire_key, thread_ref, session_id, fired_at, scheduled_at, ended_at, status, note, reply)
           SELECT old.id, f."fireKey", COALESCE(f."threadRef", 'cron:' || old.id), f."sessionId", f."firedAt"::bigint,
                  f."scheduledAt"::bigint, f."endedAt"::bigint, f.status, f.note, f.reply
             FROM crons_json old,
                  jsonb_to_recordset(old.json->'fireLog') AS f("fireKey" text, "threadRef" text, "sessionId" text,
                    "firedAt" numeric, "scheduledAt" numeric, "endedAt" numeric, status text, note text, reply text)
            WHERE jsonb_typeof(old.json->'fireLog') = 'array' AND f."fireKey" IS NOT NULL AND f."firedAt" IS NOT NULL
           ON CONFLICT (cron_id, fire_key) DO NOTHING;
         END IF;
         DROP TABLE crons_json;
       END IF;
       IF to_regclass('durable_map_versions') IS NOT NULL THEN
         DELETE FROM durable_map_versions WHERE tbl = 'crons';
       END IF;
     END $backfill$`,
  ],
};

export function createPostgresCronRows(connectionString: string): CronRows {
  const { q, pool } = createPgPool(connectionString, [CRONS_MIGRATION]);
  return {
    async insertIfAbsent(cron) {
      const inserted = await q(
        `INSERT INTO crons(${CRON.names}) VALUES (${CRON.placeholders})
         ON CONFLICT (tenant_id, id) DO UPDATE SET id = crons.id
         RETURNING ${CRON.names}`,
        CRON.params(cron),
      );
      return rowToCron(inserted[0]!);
    },
    async get(id) {
      const rows = await q(`${SELECT} WHERE ${MINE} AND id = $1`, [id]);
      return rows[0] ? rowToCron(rows[0]) : null;
    },
    async list() {
      return (await q(`${SELECT} WHERE ${MINE} ORDER BY id`)).map(rowToCron);
    },
    async ownedBy(scopeId) {
      return (await q(`${SELECT} WHERE ${MINE} AND owner_scope_id = $1 ORDER BY id`, [scopeId])).map(rowToCron);
    },
    async tiedTo(threadRefs) {
      if (!threadRefs.length) return [];
      const rows = await q(
        `${SELECT} WHERE ${MINE} AND session_ref = ANY($1::text[])
         UNION
         ${SELECT} WHERE ${MINE} AND destination IS NOT NULL AND destination->>'target' = ANY($1::text[])
         ORDER BY id`,
        [[...threadRefs]],
      );
      return rows.map(rowToCron);
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(rowToCron(current.rows[0])), id };
        await client.query(`UPDATE crons SET (${CRON.names}) = (${CRON.placeholders}) WHERE ${MINE} AND id = $1`, CRON.params(next));
        return next;
      });
    },
    async delete(id) {
      await q(`DELETE FROM crons WHERE ${MINE} AND id = $1`, [id]);
    },
    async scheduled() {
      return (await q(`${SELECT} WHERE enabled AND archived IS NOT TRUE ORDER BY tenant_id, id`)).map(tenantRow);
    },
    async dueCandidates(now) {
      const rows = await q(
        `${SELECT} WHERE enabled AND archived IS NOT TRUE
           AND (next_fire_at IS NULL OR next_fire_at <= $1)
           AND (defer_until IS NULL OR defer_until <= $1)
         ORDER BY tenant_id, id`,
        [now],
      );
      return rows.map(tenantRow);
    },
  };
}

export function createMemoryCronRows(): CronRows {
  const rows = new Map<string, { cron: Cron; tenantId: string | undefined }>();
  const sorted = () => [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  const all = (): Cron[] => sorted().map((row) => structuredClone(row.cron));
  const tenanted = (): TenantCron[] =>
    sorted().map((row) => ({ ...structuredClone(row.cron), tenantId: row.tenantId }));
  const scheduled = (cron: Cron): boolean => cron.enabled && cron.archived !== true;
  return {
    async insertIfAbsent(cron) {
      const existing = rows.get(cron.id);
      if (existing) return structuredClone(existing.cron);
      rows.set(cron.id, { cron: structuredClone(cron), tenantId: boundTenant() });
      return structuredClone(cron);
    },
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row.cron) : null;
    },
    async list() {
      return all();
    },
    async ownedBy(scopeId) {
      return all().filter((cron) => cron.ownerScopeId === scopeId);
    },
    async tiedTo(threadRefs) {
      const refs = new Set(threadRefs);
      return all().filter(
        (cron) =>
          (cron.sessionRef !== undefined && refs.has(cron.sessionRef)) ||
          (cron.destination !== undefined && refs.has(cron.destination.target)),
      );
    },
    async update(id, apply) {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...apply(structuredClone(row.cron)), id };
      row.cron = structuredClone(next);
      return next;
    },
    async delete(id) {
      rows.delete(id);
    },
    async scheduled() {
      return tenanted().filter(scheduled);
    },
    async dueCandidates(now) {
      return tenanted().filter(
        (cron) =>
          scheduled(cron) &&
          (cron.nextFireAt === undefined || cron.nextFireAt <= now) &&
          (cron.deferUntil === undefined || cron.deferUntil <= now),
      );
    },
  };
}
