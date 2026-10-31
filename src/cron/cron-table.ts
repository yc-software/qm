import type { Cron } from "../triggers/types.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE } from "../tenants/migrations.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { CRON_SEARCH_DESCRIPTION, CRON_SEARCH_TITLE } from "../search/resource-search.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type TenantCron = Cron & { tenantId: string };

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

const COLUMNS = `id, owner_scope_id, owner, created_by, owner_consented_at, destination, enabled, archived,
  created_at, last_fired_at, last_attempt_at, next_fire_at, defer_until, runtime, schedule, title, action, message,
  loop_id, unattended_grants, session_ref, last_fire_note`;

const VALUES = `$1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18,
  $19, $20::text[], $21, $22::jsonb`;

const SELECT = `SELECT tenant_id::text AS tenant_id, ${COLUMNS}, runtime::text AS runtime_json FROM crons`;

const json = (value: unknown): string | null => (value === undefined || value === null ? null : jsonbStringify(value));
const text = (value: string | undefined): string | null => (value === undefined ? null : pgTextSafe(value));

const ms = (value: number | undefined): number | null => (value === undefined ? null : Math.round(value));

function cronParams(c: Cron): unknown[] {
  return [
    c.id,
    c.ownerScopeId,
    c.owner,
    c.createdBy,
    ms(c.ownerConsentedAt),
    json(c.destination),
    c.enabled,
    c.archived ?? null,
    ms(c.createdAt),
    ms(c.lastFiredAt),
    ms(c.lastAttemptAt),
    ms(c.nextFireAt),
    ms(c.deferUntil),
    c.runtime === undefined ? null : jsonbStringify(c.runtime),
    json(c.schedule),
    text(c.title),
    text(c.action),
    text(c.message),
    c.loopId ?? null,
    c.unattendedGrants ?? null,
    c.sessionRef ?? null,
    json(c.lastFireNote),
  ];
}

const epoch = (value: unknown): number | undefined => (value === null ? undefined : Number(value));

function rowToCron(r: Record<string, unknown>): Cron {
  const cron: Cron = {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as Cron["ownerScopeId"],
    owner: r.owner as string,
    createdBy: r.created_by as string,
    ownerConsentedAt: epoch(r.owner_consented_at),
    destination: (r.destination ?? undefined) as Cron["destination"],
    enabled: r.enabled as boolean,
    archived: (r.archived ?? undefined) as boolean | undefined,
    createdAt: Number(r.created_at),
    lastFiredAt: epoch(r.last_fired_at),
    lastAttemptAt: epoch(r.last_attempt_at),
    nextFireAt: epoch(r.next_fire_at),
    deferUntil: epoch(r.defer_until),
    runtime: typeof r.runtime_json === "string" ? (JSON.parse(r.runtime_json) as Cron["runtime"]) : undefined,
    schedule: r.schedule as Cron["schedule"],
    title: (r.title ?? undefined) as string | undefined,
    action: (r.action ?? undefined) as string | undefined,
    message: (r.message ?? undefined) as string | undefined,
    loopId: (r.loop_id ?? undefined) as string | undefined,
    unattendedGrants: (r.unattended_grants ?? undefined) as string[] | undefined,
    sessionRef: (r.session_ref ?? undefined) as string | undefined,
    lastFireNote: (r.last_fire_note ?? undefined) as Cron["lastFireNote"],
  };
  for (const key of Object.keys(cron) as Array<keyof Cron>) if (cron[key] === undefined) delete cron[key];
  return cron;
}

const tenantRow = (r: Record<string, unknown>): TenantCron => ({ ...rowToCron(r), tenantId: r.tenant_id as string });

const jsonText = (field: string) => `json->>'${field}'`;
const jsonEpoch = (field: string) => `(json->>'${field}')::numeric::bigint`;
const jsonObject = (field: string) => `NULLIF(json->'${field}', 'null'::jsonb)`;

export const CRONS_MIGRATION = typedTableMigration({
  table: "crons",
  columns: [
    "id TEXT NOT NULL",
    "owner_scope_id TEXT NOT NULL",
    "owner TEXT NOT NULL",
    "created_by TEXT NOT NULL",
    "owner_consented_at BIGINT",
    "destination JSONB",
    "enabled BOOLEAN NOT NULL",
    "archived BOOLEAN",
    "created_at BIGINT NOT NULL",
    "last_fired_at BIGINT",
    "last_attempt_at BIGINT",
    "next_fire_at BIGINT",
    "defer_until BIGINT",
    "runtime JSONB",
    "schedule JSONB NOT NULL",
    "title TEXT",
    "action TEXT",
    "message TEXT",
    "loop_id TEXT",
    "unattended_grants TEXT[]",
    "session_ref TEXT",
    "last_fire_note JSONB",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    owner_scope_id: jsonText("ownerScopeId"),
    owner: jsonText("owner"),
    created_by: jsonText("createdBy"),
    owner_consented_at: jsonEpoch("ownerConsentedAt"),
    destination: jsonObject("destination"),
    enabled: "COALESCE((json->>'enabled')::boolean, false)",
    archived: "(json->>'archived')::boolean",
    created_at: `COALESCE(${jsonEpoch("createdAt")}, 0)`,
    last_fired_at: jsonEpoch("lastFiredAt"),
    last_attempt_at: jsonEpoch("lastAttemptAt"),
    next_fire_at: jsonEpoch("nextFireAt"),
    defer_until: jsonEpoch("deferUntil"),
    runtime: "json->'runtime'",
    schedule: "json->'schedule'",
    title: jsonText("title"),
    action: jsonText("action"),
    message: jsonText("message"),
    loop_id: jsonText("loopId"),
    unattended_grants:
      "CASE WHEN jsonb_typeof(json->'unattendedGrants') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'unattendedGrants')) END",
    session_ref: jsonText("sessionRef"),
    last_fire_note: jsonObject("lastFireNote"),
  },
  where:
    "json ? 'owner' AND json ? 'createdBy' AND json ? 'ownerScopeId' AND jsonb_typeof(json->'schedule') = 'object'",
  indexes: [
    "CREATE INDEX crons_by_owner_scope ON crons(tenant_id, owner_scope_id)",
    "CREATE INDEX crons_by_session_ref ON crons(tenant_id, session_ref) WHERE session_ref IS NOT NULL",
    "CREATE INDEX crons_by_destination_target ON crons(tenant_id, (destination->>'target')) WHERE destination IS NOT NULL",
    "CREATE INDEX crons_scheduled ON crons(next_fire_at) WHERE enabled AND archived IS NOT TRUE",
    `CREATE INDEX crons_resource_search_gin ON crons USING GIN (to_tsvector('simple', ${CRON_SEARCH_TITLE} || ' ' || ${CRON_SEARCH_DESCRIPTION}))`,
  ],
});

export function createPostgresCronRows(connectionString: string): CronRows & { close(): Promise<void> } {
  const db = createPgPool(connectionString, [TENANCY_BASE, CRONS_MIGRATION]);
  const { q, pool, close } = db;
  const many = async (sql: string, params: unknown[] = []) => (await q(sql, params)).map(rowToCron);
  return {
    close,
    async insertIfAbsent(cron) {
      const rows = await q(
        `INSERT INTO crons(${COLUMNS}) VALUES (${VALUES})
         ON CONFLICT (tenant_id, id) DO UPDATE SET id = crons.id
         RETURNING ${COLUMNS}, runtime::text AS runtime_json`,
        cronParams(cron),
      );
      return rowToCron(rows[0]!);
    },
    async get(id) {
      return (await many(`${SELECT} WHERE tenant_id = qm_bound_tenant() AND id = $1`, [id]))[0] ?? null;
    },
    list: () => many(`${SELECT} WHERE tenant_id = qm_bound_tenant() ORDER BY id`),
    ownedBy: (scopeId) =>
      many(`${SELECT} WHERE tenant_id = qm_bound_tenant() AND owner_scope_id = $1 ORDER BY id`, [scopeId]),
    async tiedTo(threadRefs) {
      if (!threadRefs.length) return [];
      return many(
        `${SELECT} WHERE tenant_id = qm_bound_tenant() AND session_ref = ANY($1::text[])
         UNION
         ${SELECT} WHERE tenant_id = qm_bound_tenant() AND destination IS NOT NULL
           AND destination->>'target' = ANY($1::text[])
         ORDER BY id`,
        [[...threadRefs]],
      );
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE tenant_id = qm_bound_tenant() AND id = $1 FOR UPDATE`, [
          id,
        ]);
        if (!current.rows[0]) return null;
        const next = { ...apply(rowToCron(current.rows[0])), id };
        await client.query(
          `UPDATE crons SET (${COLUMNS}) = (${VALUES}) WHERE tenant_id = qm_bound_tenant() AND id = $1`,
          cronParams(next),
        );
        return next;
      });
    },
    async delete(id) {
      await q(`DELETE FROM crons WHERE tenant_id = qm_bound_tenant() AND id = $1`, [id]);
    },
    async scheduled() {
      return (
        await claimAcrossTenants(db, `${SELECT} WHERE enabled AND archived IS NOT TRUE ORDER BY tenant_id, id`)
      ).map(tenantRow);
    },
    async dueCandidates(now) {
      const rows = await claimAcrossTenants(
        db,
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
