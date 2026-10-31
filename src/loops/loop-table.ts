import type { Loop } from "./types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { columnList, json, kvBigint, kvJsonb, kvTexts, num, present, text, texts, type Row } from "./pg-values.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";

export type TenantLoop = Loop & { tenantId: string };

export interface LoopRows {
  insertIfAbsent(loop: Loop): Promise<{ loop: Loop; created: boolean }>;
  get(id: string): Promise<Loop | null>;
  list(): Promise<Loop[]>;
  byCron(cronId: string): Promise<Loop | null>;
  byOwner(owner: string, surface: string): Promise<Loop | null>;
  byScope(ownerScopeId: string, surface: string): Promise<Loop | null>;
  update(id: string, apply: (loop: Loop) => Loop): Promise<Loop | null>;
  delete(id: string): Promise<void>;
  inboxLoops(): Promise<TenantLoop[]>;
  staleGoverned(now: number): Promise<TenantLoop[]>;
  close?(): Promise<void>;
}

const LOOPS_MIGRATION = typedTableMigration({
  table: "loops",
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
    "name TEXT NOT NULL",
    "icon TEXT",
    "purpose TEXT",
    "surface TEXT",
    "sources TEXT[]",
    "playbook TEXT NOT NULL",
    "playbook_version INTEGER NOT NULL",
    "playbook_history JSONB NOT NULL",
    "policy_version INTEGER NOT NULL",
    "success_condition TEXT NOT NULL",
    "success_checks TEXT[]",
    "ship_actions JSONB NOT NULL",
    "caps JSONB",
    "governor JSONB",
    "triage JSONB",
    "state TEXT NOT NULL",
    "health TEXT NOT NULL",
    "health_reason TEXT",
    "throttle BOOLEAN",
    "cron_id TEXT",
    "consecutive_failed_fires INTEGER",
    "quarantine_cleared_by TEXT",
    "quarantine_cleared_at BIGINT",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    owner_scope_id: "json->>'ownerScopeId'",
    owner: "json->>'owner'",
    created_by: "COALESCE(json->>'createdBy', json->>'owner')",
    owner_consented_at: kvBigint("ownerConsentedAt"),
    destination: kvJsonb("destination"),
    enabled: "COALESCE((json->>'enabled')::boolean, false)",
    created_at: `COALESCE(${kvBigint("createdAt")}, 0)`,
    last_fired_at: kvBigint("lastFiredAt"),
    name: "COALESCE(json->>'name', id)",
    icon: "json->>'icon'",
    purpose: "json->>'purpose'",
    surface: "json->>'surface'",
    sources: kvTexts("sources"),
    playbook: "COALESCE(json->>'playbook', '')",
    playbook_version: "COALESCE((json->>'playbookVersion')::integer, 1)",
    playbook_history: `COALESCE(${kvJsonb("playbookHistory")}, '[]'::jsonb)`,
    policy_version: "COALESCE((json->>'policyVersion')::integer, 1)",
    success_condition: "COALESCE(json->>'successCondition', '')",
    success_checks: kvTexts("successChecks"),
    ship_actions: `COALESCE(${kvJsonb("shipActions")}, '[]'::jsonb)`,
    caps: kvJsonb("caps"),
    governor: kvJsonb("governor"),
    triage: kvJsonb("triage"),
    state: "COALESCE(json->>'state', CASE WHEN (json->>'enabled')::boolean THEN 'enabled' ELSE 'paused' END)",
    health: "COALESCE(json->>'health', 'healthy')",
    health_reason: "json->>'healthReason'",
    throttle: "(json->>'throttle')::boolean",
    cron_id: "json->>'cronId'",
    consecutive_failed_fires: "(json->>'consecutiveFailedFires')::integer",
    quarantine_cleared_by: "json->>'quarantineClearedBy'",
    quarantine_cleared_at: kvBigint("quarantineClearedAt"),
  },
  where: "json->>'owner' IS NOT NULL AND json->>'ownerScopeId' IS NOT NULL",
  indexes: [
    "CREATE INDEX loops_by_owner ON loops(tenant_id, owner, surface)",
    "CREATE INDEX loops_by_scope ON loops(tenant_id, owner_scope_id, surface)",
    "CREATE INDEX loops_by_cron ON loops(tenant_id, cron_id) WHERE cron_id IS NOT NULL",
    "CREATE INDEX loops_inbox ON loops(state) WHERE surface = 'inbox' OR surface LIKE 'inbox:%'",
    "CREATE INDEX loops_stale_governed ON loops(state) WHERE governor ? 'staleFireMs'",
  ],
});

const { names: COLUMNS, values: PLACEHOLDERS } = columnList([
  ["id", "text"],
  ["owner_scope_id", "text"],
  ["owner", "text"],
  ["created_by", "text"],
  ["owner_consented_at", "bigint"],
  ["destination", "jsonb"],
  ["enabled", "boolean"],
  ["created_at", "bigint"],
  ["last_fired_at", "bigint"],
  ["name", "text"],
  ["icon", "text"],
  ["purpose", "text"],
  ["surface", "text"],
  ["sources", "text[]"],
  ["playbook", "text"],
  ["playbook_version", "integer"],
  ["playbook_history", "jsonb"],
  ["policy_version", "integer"],
  ["success_condition", "text"],
  ["success_checks", "text[]"],
  ["ship_actions", "jsonb"],
  ["caps", "jsonb"],
  ["governor", "jsonb"],
  ["triage", "jsonb"],
  ["state", "text"],
  ["health", "text"],
  ["health_reason", "text"],
  ["throttle", "boolean"],
  ["cron_id", "text"],
  ["consecutive_failed_fires", "integer"],
  ["quarantine_cleared_by", "text"],
  ["quarantine_cleared_at", "bigint"],
]);

const SELECT = `SELECT tenant_id::text AS tenant_id, ${COLUMNS} FROM loops`;

const MINE = `tenant_id = ${TENANT}`;

const INBOX = "(surface = 'inbox' OR surface LIKE 'inbox:%')";

function params(loop: Loop): unknown[] {
  return [
    loop.id,
    text(loop.ownerScopeId),
    text(loop.owner),
    text(loop.createdBy),
    loop.ownerConsentedAt ?? null,
    json(loop.destination),
    loop.enabled,
    loop.createdAt,
    loop.lastFiredAt ?? null,
    text(loop.name),
    text(loop.icon),
    text(loop.purpose),
    text(loop.surface),
    texts(loop.sources),
    text(loop.playbook),
    loop.playbookVersion,
    json(loop.playbookHistory),
    loop.policyVersion ?? 1,
    text(loop.successCondition),
    texts(loop.successChecks),
    json(loop.shipActions),
    json(loop.caps),
    json(loop.governor),
    json(loop.triage),
    loop.state,
    loop.health,
    text(loop.healthReason),
    loop.throttle ?? null,
    text(loop.cronId),
    loop.consecutiveFailedFires ?? null,
    text(loop.quarantineClearedBy),
    loop.quarantineClearedAt ?? null,
  ];
}

function fromRow(r: Row): Loop {
  return present<Loop>({
    id: r.id,
    ownerScopeId: r.owner_scope_id,
    owner: r.owner,
    createdBy: r.created_by,
    ownerConsentedAt: num(r.owner_consented_at),
    destination: r.destination,
    enabled: r.enabled,
    createdAt: num(r.created_at),
    lastFiredAt: num(r.last_fired_at),
    name: r.name,
    icon: r.icon,
    purpose: r.purpose,
    surface: r.surface,
    sources: r.sources,
    playbook: r.playbook,
    playbookVersion: r.playbook_version,
    playbookHistory: r.playbook_history,
    policyVersion: r.policy_version,
    successCondition: r.success_condition,
    successChecks: r.success_checks,
    shipActions: r.ship_actions,
    caps: r.caps,
    governor: r.governor,
    triage: r.triage,
    state: r.state,
    health: r.health,
    healthReason: r.health_reason,
    throttle: r.throttle,
    cronId: r.cron_id,
    consecutiveFailedFires: r.consecutive_failed_fires,
    quarantineClearedBy: r.quarantine_cleared_by,
    quarantineClearedAt: num(r.quarantine_cleared_at),
  });
}

const tenantRow = (r: Row): TenantLoop => ({ ...fromRow(r), tenantId: r.tenant_id as string });

export function createPostgresLoopRows(connectionString: string): LoopRows {
  const db = createPgPool(connectionString, [TENANCY_BASE, LOOPS_MIGRATION]);
  const { q, pool, close } = db;
  const first = async (where: string, values: unknown[]): Promise<Loop | null> => {
    const rows = await q(`${SELECT} WHERE ${MINE} AND ${where} ORDER BY id LIMIT 1`, values);
    return rows[0] ? fromRow(rows[0]) : null;
  };
  return {
    async insertIfAbsent(loop) {
      const inserted = await q(
        `INSERT INTO loops(${COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
        params(loop),
      );
      if (inserted.length) return { loop, created: true };
      return { loop: (await first("id = $1", [loop.id])) ?? loop, created: false };
    },
    get: (id) => first("id = $1", [id]),
    async list() {
      return (await q(`${SELECT} WHERE ${MINE} ORDER BY id`)).map(fromRow);
    },
    byCron: (cronId) => first("cron_id = $1", [cronId]),
    byOwner: (owner, surface) => first("owner = $1 AND surface = $2", [owner, surface]),
    byScope: (ownerScopeId, surface) => first("owner_scope_id = $1 AND surface = $2", [ownerScopeId, surface]),
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(fromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loops SET (${COLUMNS}) = ROW(${PLACEHOLDERS}) WHERE ${MINE} AND id = $1`,
          params(next),
        );
        return present<Loop>(next as unknown as Row);
      });
    },
    async delete(id) {
      await q(`DELETE FROM loops WHERE ${MINE} AND id = $1`, [id]);
    },
    async inboxLoops() {
      return (
        await claimAcrossTenants(db, `${SELECT} WHERE ${INBOX} AND state <> 'archived' ORDER BY tenant_id, id`)
      ).map(tenantRow);
    },
    async staleGoverned(now) {
      const rows = await claimAcrossTenants(
        db,
        `${SELECT} WHERE governor ? 'staleFireMs' AND state = 'enabled'
           AND $1 - COALESCE(last_fired_at, created_at) > (governor->>'staleFireMs')::numeric
         ORDER BY tenant_id, id`,
        [now],
      );
      return rows.map(tenantRow);
    },
    close,
  };
}
