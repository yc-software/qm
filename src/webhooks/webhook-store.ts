import type { Webhook } from "../types.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import {
  cols,
  mapToTableMigration,
  ownerIndexMigration,
  type TableSpec,
  typedTable,
} from "../persistence/typed-table.ts";
import {
  assertNoEscalation,
  buildTriggerBase,
  contentPart,
  TRIGGER_COLUMNS,
  type CreateTriggerInput,
} from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { jsonbStringify } from "../util/text.ts";
import { getVerifier } from "./verifiers.ts";
import { LOOP_INGRESS_TO_WEBHOOKS_MIGRATION } from "./loop-ingress-migration.ts";

const HISTORY_EVENTS = 50;

export interface CreateWebhookInput extends CreateTriggerInput {
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
}

export interface WebhookEvent {
  deliveryId: string;
  receivedAt: number;
  payload: string;
}

export interface WebhookStore {
  recordEvent(id: string, event: WebhookEvent): Promise<void>;
  listEvents(id: string): Promise<WebhookEvent[]>;
  create(input: CreateWebhookInput): Promise<Webhook>;
  get(id: string): Promise<Webhook | null>;
  list(): Promise<Webhook[]>;
  byOwner(scopeId: string): Promise<Webhook[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  update(id: string, patch: { action: string }): Promise<Webhook | null>;
  recordFire(id: string, info: { at: number; deliveryId?: string; error?: string }): Promise<void>;
}

const WEBHOOKS: TableSpec = {
  table: "webhooks",
  key: "id",
  keyIsField: true,
  columns: {
    ...TRIGGER_COLUMNS,
    ...cols(`action text!, verification jsonb!, filters jsonb, lastDeliveryId text, lastError text`),
  },
};

const WEBHOOK_HISTORY: TableSpec = {
  table: "webhook_history",
  key: "id",
  columns: { events: { type: "jsonb", required: true } },
};

export const WEBHOOKS_MIGRATION = mapToTableMigration("triggers/webhooks/0001-typed", WEBHOOKS, {
  statements: [
    `CREATE INDEX IF NOT EXISTS webhooks_resource_search_gin ON webhooks USING gin
     (to_tsvector('simple', coalesce(action, '') || ' ' || coalesce(verification->>'scheme', '')))`,
  ],
});

const WEBHOOK_HISTORY_MIGRATION = mapToTableMigration("triggers/webhook-history/0001-typed", WEBHOOK_HISTORY);

const NEWEST_FIRST = `(e->>'receivedAt')::float8 DESC, e->>'deliveryId'`;

export function createWebhookStore(databaseUrl: string): WebhookStore {
  const db = createPgPool(databaseUrl, [
    WEBHOOKS_MIGRATION,
    WEBHOOK_HISTORY_MIGRATION,
    ownerIndexMigration("webhooks"),
    LOOP_INGRESS_TO_WEBHOOKS_MIGRATION,
  ]);
  const { q } = db;
  const table = typedTable<Webhook>(db, WEBHOOKS);
  const history = typedTable<{ events: WebhookEvent[] }>(db, WEBHOOK_HISTORY);
  const setEnabled = async (id: string, enabled: boolean) => {
    await q(`UPDATE webhooks SET enabled = $2 WHERE id = $1`, [id, enabled]);
  };
  return {
    async recordEvent(id, event) {
      await q(
        `INSERT INTO webhook_history AS h (id, events) VALUES ($1, jsonb_build_array($2::jsonb))
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET events = (
           SELECT jsonb_agg(e ORDER BY ${NEWEST_FIRST}) FROM (
             SELECT e FROM jsonb_array_elements(h.events || EXCLUDED.events) e ORDER BY ${NEWEST_FIRST} LIMIT $3
           ) newest)
         WHERE NOT h.events @> jsonb_build_array(jsonb_build_object('deliveryId', $4::text))`,
        [id, jsonbStringify(event), HISTORY_EVENTS, event.deliveryId],
      );
    },
    listEvents: async (id) => (await history.get(id))?.events ?? [],
    async create(input) {
      assertNoEscalation(input);
      if (!getVerifier(input.verification.scheme) || !input.verification.secret) {
        throw new Error("webhook verification requires a supported signed scheme and secret");
      }
      if (
        input.filters?.some(
          (filter) => !filter.path.trim() || filter.in.length === 0 || filter.in.some((value) => !value.trim()),
        )
      ) {
        throw new Error("every webhook filter requires a path and at least one value");
      }
      const filters = input.filters?.length ? input.filters : undefined;
      const contentId = hashId([
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.action),
        contentPart(input.verification),
        contentPart(filters),
        contentPart(input.destination),
      ]);
      const webhook = await table.insertOrGet(contentId, {
        ...buildTriggerBase(input, contentId, Date.now()),
        action: input.action,
        verification: input.verification,
        ...(filters ? { filters } : {}),
      });
      if (webhook.enabled) return webhook;
      await setEnabled(webhook.id, true);
      return { ...webhook, enabled: true };
    },
    get: table.get,
    list: table.all,
    byOwner: (scopeId) => table.where("ownerScopeId", scopeId),
    setEnabled,
    async update(id, patch) {
      const rows = await q(`UPDATE webhooks SET action = $2 WHERE id = $1 RETURNING ${table.codec.columns}`, [
        id,
        patch.action,
      ]);
      return table.codec.rows(rows)[0] ?? null;
    },
    async recordFire(id, info) {
      await q(
        `UPDATE webhooks SET last_fired_at = $2, last_delivery_id = COALESCE($3, last_delivery_id), last_error = $4
         WHERE id = $1`,
        [id, info.at, info.deliveryId || null, info.error ?? null],
      );
    },
  };
}
