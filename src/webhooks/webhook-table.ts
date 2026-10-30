import type { Webhook } from "../types.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { currentTenant } from "../tenants/context.ts";
import { TENANCY_BASE, tenantPolicies } from "../tenants/migrations.ts";
import { createPgPool, withPgTransaction, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export interface WebhookEvent {
  deliveryId: string;
  receivedAt: number;
  payload: string;
}

export const WEBHOOK_EVENTS_KEPT = 50;

export interface WebhookRows {
  insertIfAbsent(webhook: Webhook): Promise<Webhook>;
  get(id: string): Promise<Webhook | null>;
  list(): Promise<Webhook[]>;
  ownedBy(scopeId: string): Promise<Webhook[]>;
  update(id: string, apply: (webhook: Webhook) => Webhook): Promise<Webhook | null>;
  recordEvent(webhookId: string, event: WebhookEvent): Promise<void>;
  listEvents(webhookId: string): Promise<WebhookEvent[]>;
}

const COLUMNS = `id, owner_scope_id, owner, created_by, owner_consented_at, destination, enabled, created_at,
  last_fired_at, action, verification, filters, last_delivery_id, last_error`;

const VALUES = "$1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14";

const SELECT = `SELECT ${COLUMNS} FROM webhooks`;

const json = (value: unknown): string | null => (value === undefined || value === null ? null : jsonbStringify(value));

function webhookParams(w: Webhook): unknown[] {
  return [
    w.id,
    w.ownerScopeId,
    w.owner,
    w.createdBy,
    w.ownerConsentedAt ?? null,
    json(w.destination),
    w.enabled,
    w.createdAt,
    w.lastFiredAt ?? null,
    pgTextSafe(w.action),
    json(w.verification),
    json(w.filters),
    w.lastDeliveryId ?? null,
    w.lastError === undefined ? null : pgTextSafe(w.lastError),
  ];
}

function rowToWebhook(r: Record<string, unknown>): Webhook {
  const webhook: Webhook = {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as Webhook["ownerScopeId"],
    owner: r.owner as string,
    createdBy: r.created_by as string,
    ownerConsentedAt: r.owner_consented_at === null ? undefined : Number(r.owner_consented_at),
    destination: (r.destination ?? undefined) as Webhook["destination"],
    enabled: r.enabled as boolean,
    createdAt: Number(r.created_at),
    lastFiredAt: r.last_fired_at === null ? undefined : Number(r.last_fired_at),
    action: r.action as string,
    verification: r.verification as Webhook["verification"],
    filters: (r.filters ?? undefined) as Webhook["filters"],
    lastDeliveryId: (r.last_delivery_id ?? undefined) as string | undefined,
    lastError: (r.last_error ?? undefined) as string | undefined,
  };
  for (const key of Object.keys(webhook) as Array<keyof Webhook>) if (webhook[key] === undefined) delete webhook[key];
  return webhook;
}

export const WEBHOOKS_MIGRATION = typedTableMigration({
  table: "webhooks",
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
    "action TEXT NOT NULL",
    "verification JSONB NOT NULL",
    "filters JSONB",
    "last_delivery_id TEXT",
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
    action: "json->>'action'",
    verification: "json->'verification'",
    filters: "NULLIF(json->'filters', 'null'::jsonb)",
    last_delivery_id: "json->>'lastDeliveryId'",
    last_error: "json->>'lastError'",
  },
  indexes: ["CREATE INDEX webhooks_by_owner_scope ON webhooks(tenant_id, owner_scope_id)"],
});

export const WEBHOOK_EVENTS_MIGRATION: PgMigrationDefinition = {
  id: "tenancy/webhook_events/0001-typed",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS webhook_history(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `CREATE TABLE webhook_events(
       tenant_id UUID NOT NULL DEFAULT qm_tenant_id() REFERENCES tenants,
       webhook_id TEXT NOT NULL,
       delivery_id TEXT NOT NULL,
       received_at BIGINT NOT NULL,
       payload TEXT NOT NULL,
       PRIMARY KEY (tenant_id, webhook_id, delivery_id)
     )`,
    `INSERT INTO webhook_events(tenant_id, webhook_id, delivery_id, received_at, payload)
       SELECT (SELECT id FROM tenants), old.id, e."deliveryId", e."receivedAt"::bigint, e.payload
         FROM webhook_history old,
              jsonb_to_recordset(old.json->'events') AS e("deliveryId" text, "receivedAt" numeric, payload text)
        WHERE jsonb_typeof(old.json->'events') = 'array'
       ON CONFLICT DO NOTHING`,
    `DROP TABLE webhook_history`,
    `DO $drop_version$ BEGIN
       IF to_regclass('durable_map_versions') IS NOT NULL THEN
         DELETE FROM durable_map_versions WHERE tbl = 'webhook_history';
       END IF;
     END $drop_version$`,
    `CREATE INDEX webhook_events_recent ON webhook_events(tenant_id, webhook_id, received_at DESC, delivery_id)`,
    ...tenantPolicies("webhook_events"),
  ],
};

const eventOrder = (a: WebhookEvent, b: WebhookEvent): number =>
  b.receivedAt - a.receivedAt || a.deliveryId.localeCompare(b.deliveryId);

export function createPostgresWebhookRows(connectionString: string): WebhookRows & { close(): Promise<void> } {
  const { q, pool, close } = createPgPool(connectionString, [
    TENANCY_BASE,
    WEBHOOKS_MIGRATION,
    WEBHOOK_EVENTS_MIGRATION,
  ]);
  const many = async (sql: string, params: unknown[] = []) => (await q(sql, params)).map(rowToWebhook);
  return {
    close,
    async insertIfAbsent(webhook) {
      const rows = await q(
        `INSERT INTO webhooks(${COLUMNS}) VALUES (${VALUES})
         ON CONFLICT (tenant_id, id) DO UPDATE SET id = webhooks.id
         RETURNING ${COLUMNS}`,
        webhookParams(webhook),
      );
      return rowToWebhook(rows[0]!);
    },
    async get(id) {
      return (await many(`${SELECT} WHERE tenant_id = qm_tenant_id() AND id = $1`, [id]))[0] ?? null;
    },
    list: () => many(`${SELECT} WHERE tenant_id = qm_tenant_id() ORDER BY id`),
    ownedBy: (scopeId) =>
      many(`${SELECT} WHERE tenant_id = qm_tenant_id() AND owner_scope_id = $1 ORDER BY id`, [scopeId]),
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE tenant_id = qm_tenant_id() AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(rowToWebhook(current.rows[0])), id };
        await client.query(
          `UPDATE webhooks SET (${COLUMNS}) = (${VALUES}) WHERE tenant_id = qm_tenant_id() AND id = $1`,
          webhookParams(next),
        );
        return next;
      });
    },
    async recordEvent(webhookId, event) {
      await withPgTransaction(await pool(), async (client) => {
        await client.query(
          `INSERT INTO webhook_events(webhook_id, delivery_id, received_at, payload) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [webhookId, pgTextSafe(event.deliveryId), event.receivedAt, pgTextSafe(event.payload)],
        );
        await client.query(
          `DELETE FROM webhook_events WHERE tenant_id = qm_tenant_id() AND webhook_id = $1 AND delivery_id IN (
             SELECT delivery_id FROM webhook_events WHERE tenant_id = qm_tenant_id() AND webhook_id = $1
              ORDER BY received_at DESC, delivery_id OFFSET $2)`,
          [webhookId, WEBHOOK_EVENTS_KEPT],
        );
      });
    },
    async listEvents(webhookId) {
      const rows = await q(
        `SELECT delivery_id, received_at, payload FROM webhook_events
          WHERE tenant_id = qm_tenant_id() AND webhook_id = $1
          ORDER BY received_at DESC, delivery_id LIMIT $2`,
        [webhookId, WEBHOOK_EVENTS_KEPT],
      );
      return rows.map((r) => ({
        deliveryId: r.delivery_id as string,
        receivedAt: Number(r.received_at),
        payload: r.payload as string,
      }));
    },
  };
}

export function createMemoryWebhookRows(): WebhookRows {
  const tenants = new Map<string, { webhooks: Map<string, Webhook>; events: Map<string, WebhookEvent[]> }>();
  const mine = () => {
    const tenant = currentTenant();
    if (!tenants.has(tenant)) tenants.set(tenant, { webhooks: new Map(), events: new Map() });
    return tenants.get(tenant)!;
  };
  const all = (): Webhook[] =>
    [...mine().webhooks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, w]) => structuredClone(w));
  return {
    async insertIfAbsent(webhook) {
      const { webhooks } = mine();
      if (!webhooks.has(webhook.id)) webhooks.set(webhook.id, structuredClone(webhook));
      return structuredClone(webhooks.get(webhook.id)!);
    },
    async get(id) {
      const webhook = mine().webhooks.get(id);
      return webhook ? structuredClone(webhook) : null;
    },
    async list() {
      return all();
    },
    async ownedBy(scopeId) {
      return all().filter((w) => w.ownerScopeId === scopeId);
    },
    async update(id, apply) {
      const { webhooks } = mine();
      const current = webhooks.get(id);
      if (!current) return null;
      const next = { ...apply(structuredClone(current)), id };
      webhooks.set(id, structuredClone(next));
      return next;
    },
    async recordEvent(webhookId, event) {
      const { events } = mine();
      const list = events.get(webhookId) ?? [];
      if (list.some((e) => e.deliveryId === event.deliveryId)) return;
      events.set(webhookId, [...list, { ...event }].sort(eventOrder).slice(0, WEBHOOK_EVENTS_KEPT));
    },
    async listEvents(webhookId) {
      return structuredClone(mine().events.get(webhookId) ?? []);
    },
  };
}
