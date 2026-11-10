import { tenantListeners } from "../tenants/cache.ts";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { Delivery, DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import { DELIVERY_MAX_AGE_MS, logDeliveryExpiry, type DeliveryStore } from "./delivery-store.ts";
import { pgTextSafe } from "../util/text.ts";
import { tenantTables } from "../tenants/migrations.ts";
import { claimFunction, claimRows, claimThenLoad } from "../tenants/claim.ts";

const NOW_MS_SQL = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT";
const CLAIMABLE = `delivered_at IS NULL AND expired_at IS NULL AND NOT shadow
  AND (claim_expires_at IS NULL OR claim_expires_at <= ${NOW_MS_SQL})`;
const LIVE_CLAIMABLE = `${CLAIMABLE} AND hold IS NULL`;
const OVERAGED = `${CLAIMABLE} AND destination->'webTranscript'->>'kind' IS DISTINCT FROM 'slack_reply'
  AND created_at <= ${NOW_MS_SQL} - $1`;
const LIVE_OVERAGED = `${OVERAGED} AND hold IS NULL`;
const UNDELIVERED = "delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND hold IS NULL";
function rowToDelivery(r: Record<string, unknown>): Delivery {
  return {
    id: r.id as string,
    destination: r.destination as Destination,
    text: r.text as string,
    ...(r.attachments != null ? { attachments: r.attachments as OutgoingAttachment[] } : {}),
    ...(r.provenance != null ? { provenance: r.provenance as DeliveryProvenance } : {}),
    idempotencyKey: r.idempotency_key as string,
    createdAt: Number(r.created_at),
    deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
    ...(r.expired_at != null ? { expiredAt: Number(r.expired_at) } : {}),
    ...(r.failed_reason != null ? { failedReason: r.failed_reason as string } : {}),
    ...(r.shadow === true ? { shadow: true } : {}),
    ...(r.hold != null ? { hold: { kind: r.hold as "triage" | "digest", until: Number(r.held_until) } } : {}),
    ...(r.source_cron_id != null ? { sourceCronId: r.source_cron_id as string } : {}),
    ...(r.recipient_thread_ref != null ? { recipientThreadRef: r.recipient_thread_ref as string } : {}),
    ...(r.deliver_latency_ms != null ? { deliverLatencyMs: Number(r.deliver_latency_ms) } : {}),
    ...(r.slack_api_ms != null ? { slackApiMs: Number(r.slack_api_ms) } : {}),
  };
}

export function createPostgresDeliveryStore(connectionString: string, opts?: { maxAgeMs?: number }): DeliveryStore {
  const maxAgeMs = opts?.maxAgeMs ?? DELIVERY_MAX_AGE_MS;
  const pg = createPgPool(connectionString, [
    {
      id: "delivery/store/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS deliveries(
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        destination JSONB NOT NULL,
        text TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        delivered_at BIGINT
      )`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_pending
        ON deliveries ((destination->>'type'), created_at) WHERE delivered_at IS NULL`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS attachments JSONB`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS provenance JSONB`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS recipient_thread_ref TEXT`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS deliver_latency_ms INT`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS slack_api_ms INT`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_thread
        ON deliveries (recipient_thread_ref, created_at) WHERE recipient_thread_ref IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_shadow
        ON deliveries (created_at) WHERE shadow AND delivered_at IS NULL`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_source_session
        ON deliveries ((provenance->>'sourceSessionId'), created_at) WHERE provenance IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_source_thread
        ON deliveries ((provenance->>'sourceThreadRef'), created_at) WHERE provenance IS NOT NULL`,
      ],
    },
    {
      id: "delivery/store/0004",
      statements: [`ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS expired_at BIGINT`],
    },
    {
      id: "delivery/store/0005",
      statements: [
        `CREATE INDEX IF NOT EXISTS idx_deliveries_pending_live
        ON deliveries ((destination->>'type'), created_at) WHERE delivered_at IS NULL AND expired_at IS NULL`,
      ],
    },
    {
      id: "delivery/store/0006",
      statements: [
        `SET LOCAL lock_timeout = '3s'`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS source_cron_id TEXT`,
      ],
    },
    {
      id: "delivery/store/0007",
      statements: [
        `SET LOCAL lock_timeout = '3s'`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS failed_reason TEXT`,
      ],
    },
    ...tenantTables("delivery/store/0008-tenants", [
      {
        table: "deliveries",
        primaryKey: "id",
        unique: [{ name: "deliveries_idempotency_key_key", columns: "idempotency_key", constraint: true }],
      },
    ]),
    {
      id: "delivery/store/0009-claims",
      statements: [
        claimFunction(
          "expire_deliveries",
          "bigint",
          `UPDATE deliveries SET expired_at = ${NOW_MS_SQL}
            WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM deliveries WHERE ${OVERAGED} FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text`,
        ),
        claimFunction(
          "claim_deliveries",
          "text, bigint",
          `SELECT pg_advisory_xact_lock(hashtext('deliveries:claim:' || $1));
          UPDATE deliveries SET claim_expires_at = ${NOW_MS_SQL} + $2
            WHERE (tenant_id, id) IN (
              SELECT tenant_id, id FROM deliveries d
               WHERE ${CLAIMABLE} AND destination->>'type' = $1
                 AND NOT EXISTS (
                   SELECT 1 FROM deliveries o
                    WHERE o.tenant_id = d.tenant_id AND o.destination->>'type' = $1
                      AND o.destination->>'target' = d.destination->>'target'
                      AND o.delivered_at IS NULL AND o.expired_at IS NULL AND NOT o.shadow
                      AND (o.claim_expires_at > ${NOW_MS_SQL} OR (o.created_at, o.id) < (d.created_at, d.id)))
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text`,
        ),
      ],
    },
    {
      id: "delivery/store/0010-undelivered-claims",
      statements: [
        claimFunction(
          "undelivered_deliveries",
          "text",
          `SELECT tenant_id, id::text FROM deliveries
            WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = $1
            ORDER BY created_at LIMIT 200`,
        ),
      ],
    },
    {
      id: "delivery/store/0011-undelivered-uncapped",
      statements: [
        claimFunction(
          "undelivered_deliveries",
          "text",
          `SELECT tenant_id, id::text FROM deliveries
            WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = $1
            ORDER BY created_at`,
        ),
      ],
    },
    {
      id: "delivery/store/0012-undelivered-tenants",
      statements: [
        "DROP FUNCTION IF EXISTS undelivered_deliveries(text)",
        claimFunction(
          "undelivered_delivery_tenants",
          "text",
          `SELECT DISTINCT tenant_id, $1 FROM deliveries
            WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = $1`,
        ),
      ],
    },
    {
      id: "delivery/store/0013-held",
      statements: [
        `SET LOCAL lock_timeout = '3s'`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS hold TEXT CHECK (hold IN ('triage', 'digest'))`,
        `ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS held_until BIGINT`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_held ON deliveries (held_until) WHERE hold IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_deliveries_source_cron
        ON deliveries (source_cron_id, created_at) WHERE source_cron_id IS NOT NULL`,
        claimFunction(
          "expire_deliveries",
          "bigint",
          `UPDATE deliveries SET expired_at = ${NOW_MS_SQL}
            WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM deliveries WHERE ${LIVE_OVERAGED} FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text`,
        ),
        claimFunction(
          "claim_deliveries",
          "text, bigint",
          `SELECT pg_advisory_xact_lock(hashtext('deliveries:claim:' || $1));
          UPDATE deliveries SET claim_expires_at = ${NOW_MS_SQL} + $2
            WHERE (tenant_id, id) IN (
              SELECT tenant_id, id FROM deliveries d
               WHERE ${LIVE_CLAIMABLE} AND destination->>'type' = $1
                 AND NOT EXISTS (
                   SELECT 1 FROM deliveries o
                    WHERE o.tenant_id = d.tenant_id AND o.destination->>'type' = $1
                      AND o.destination->>'target' = d.destination->>'target'
                      AND o.delivered_at IS NULL AND o.expired_at IS NULL AND NOT o.shadow AND o.hold IS NULL
                      AND (o.claim_expires_at > ${NOW_MS_SQL} OR (o.created_at, o.id) < (d.created_at, d.id)))
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED)
            RETURNING tenant_id, id::text`,
        ),
        claimFunction(
          "undelivered_delivery_tenants",
          "text",
          `SELECT DISTINCT tenant_id, $1 FROM deliveries WHERE ${UNDELIVERED} AND destination->>'type' = $1`,
        ),
        claimFunction(
          "held_delivery_tenants",
          "bigint",
          `SELECT DISTINCT tenant_id, 'held' FROM deliveries WHERE hold IS NOT NULL AND held_until <= $1`,
        ),
      ],
    },
  ]);
  const { q, query } = pg;

  const enqueueListeners = tenantListeners<[string]>("delivery enqueue");

  async function get(id: string): Promise<Delivery | null> {
    const rows = await q("SELECT * FROM deliveries WHERE id = $1", [id]);
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async function expireOveraged(): Promise<void> {
    const rows = await q(
      `UPDATE deliveries
          SET expired_at = ${NOW_MS_SQL}
        WHERE id IN (SELECT id FROM deliveries WHERE ${LIVE_OVERAGED} FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [maxAgeMs],
    );
    for (const r of rows) {
      const d = rowToDelivery(r);
      logDeliveryExpiry(d, d.expiredAt ?? Date.now());
    }
  }

  return {
    async enqueue(input) {
      const inserted = await q(
        `INSERT INTO deliveries
           (id, idempotency_key, destination, text, attachments, provenance, created_at, shadow, hold, held_until, source_cron_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET destination = EXCLUDED.destination,
               text = EXCLUDED.text,
               attachments = EXCLUDED.attachments,
               provenance = EXCLUDED.provenance,
               created_at = EXCLUDED.created_at,
               shadow = EXCLUDED.shadow,
               hold = EXCLUDED.hold,
               held_until = EXCLUDED.held_until,
               source_cron_id = EXCLUDED.source_cron_id,
               expired_at = NULL,
               claim_expires_at = NULL
           WHERE deliveries.delivered_at IS NULL AND deliveries.expired_at IS NOT NULL
             AND deliveries.failed_reason IS NULL
         RETURNING *`,
        [
          randomUUID(),
          input.idempotencyKey,
          JSON.stringify(input.destination),
          pgTextSafe(input.text),
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          input.provenance ? JSON.stringify(input.provenance) : null,
          Date.now(),
          input.shadow === true,
          input.hold?.kind ?? null,
          input.hold?.until ?? null,
          input.sourceCronId ?? null,
        ],
      );
      if (inserted[0]) {
        if (input.shadow !== true && !input.hold) enqueueListeners.emit(input.destination.type);
        return rowToDelivery(inserted[0]);
      }
      const existing = await q("SELECT * FROM deliveries WHERE idempotency_key = $1", [input.idempotencyKey]);
      if (!existing[0]) throw new Error(`delivery enqueue lost a race for key ${input.idempotencyKey}`);
      return rowToDelivery(existing[0]);
    },
    async pending(type) {
      const rows = await q(
        `SELECT * FROM deliveries
          WHERE ${UNDELIVERED} AND destination->>'type' = $1
          ORDER BY created_at`,
        [type],
      );
      return rows.map(rowToDelivery);
    },
    async claimPending(type, ttlMs) {
      await expireOveraged();
      const rows = await q(
        `UPDATE deliveries SET claim_expires_at = ${NOW_MS_SQL} + $2
          WHERE id IN (
            SELECT id FROM deliveries WHERE ${LIVE_CLAIMABLE} AND destination->>'type' = $1
             ORDER BY created_at FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [type, ttlMs],
      );
      return rows.map(rowToDelivery).sort((a, b) => a.createdAt - b.createdAt);
    },
    async claimDue(type, ttlMs) {
      const load = async (ids: string[]) =>
        (await q("SELECT * FROM deliveries WHERE id = ANY($1)", [ids])).map(rowToDelivery);
      for (const d of await claimThenLoad(() => claimRows(pg, "expire_deliveries", [maxAgeMs]), load))
        logDeliveryExpiry(d, d.expiredAt ?? Date.now());
      const claimed = await claimThenLoad(() => claimRows(pg, "claim_deliveries", [type, ttlMs]), load);
      return claimed.sort((a, b) => a.createdAt - b.createdAt);
    },
    undeliveredTenants: (type) => claimRows(pg, "undelivered_delivery_tenants", [type]),
    heldTenants: (now) => claimRows(pg, "held_delivery_tenants", [now]),
    async listHeld() {
      return (await q("SELECT * FROM deliveries WHERE hold IS NOT NULL ORDER BY created_at")).map(rowToDelivery);
    },
    async settleHeld(ids, at, droppedReason) {
      await query(
        `UPDATE deliveries
            SET hold = NULL,
                delivered_at = CASE WHEN $3::text IS NULL THEN $2::bigint END,
                expired_at = CASE WHEN $3::text IS NULL THEN NULL ELSE $2::bigint END,
                failed_reason = $3
          WHERE id = ANY($1::text[]) AND hold IS NOT NULL`,
        [ids, at, droppedReason ?? null],
      );
    },
    async lastCronTexts(cronIds) {
      const rows = await q(
        `SELECT DISTINCT ON (source_cron_id) source_cron_id, text FROM deliveries
          WHERE source_cron_id = ANY($1::text[]) AND hold IS NULL
          ORDER BY source_cron_id, created_at DESC`,
        [cronIds],
      );
      return new Map(rows.map((r) => [r.source_cron_id as string, r.text as string]));
    },
    async listShadow(opts) {
      const limit = Math.max(1, opts?.limit ?? 100);
      const rows = await q(
        "SELECT * FROM deliveries WHERE shadow AND delivered_at IS NULL ORDER BY created_at DESC LIMIT $1",
        [limit],
      );
      return rows.map(rowToDelivery);
    },
    async ack(id, at, slackApiMs) {
      await query(
        `UPDATE deliveries
            SET delivered_at = $2,
                expired_at = NULL,
                deliver_latency_ms = GREATEST(0, $2 - created_at),
                slack_api_ms = COALESCE($3, slack_api_ms)
          WHERE id = $1 AND delivered_at IS NULL`,
        [id, at, slackApiMs ?? null],
      );
    },
    async fail(id, reason, at) {
      const rows = await q(
        `UPDATE deliveries
            SET expired_at = $3, failed_reason = $2, claim_expires_at = NULL
          WHERE id = $1 AND delivered_at IS NULL AND expired_at IS NULL
          RETURNING *`,
        [id, reason, at],
      );
      return rows[0] ? rowToDelivery(rows[0]) : null;
    },
    async ackByKey(idempotencyKey, at) {
      await query(
        `INSERT INTO deliveries (id, idempotency_key, destination, text, created_at, delivered_at)
         VALUES ($1, $2, '{"type":"ack-tombstone","target":""}', '', $3, $3)
         ON CONFLICT (tenant_id, idempotency_key)
         DO UPDATE SET delivered_at = COALESCE(deliveries.delivered_at, EXCLUDED.delivered_at),
                       expired_at = CASE WHEN deliveries.delivered_at IS NULL THEN NULL ELSE deliveries.expired_at END`,
        [randomUUID(), idempotencyKey, at],
      );
    },
    async setEditRefByKey(idempotencyKey, editRef) {
      await query(
        `UPDATE deliveries SET destination = jsonb_set(destination, '{editRef}', to_jsonb($2::text))
         WHERE idempotency_key = $1 AND delivered_at IS NULL`,
        [idempotencyKey, editRef],
      );
    },
    get,
    async existingKeys(idempotencyKeys) {
      if (!idempotencyKeys.length) return new Set();
      const rows = await q("SELECT idempotency_key FROM deliveries WHERE idempotency_key = ANY($1::text[])", [
        idempotencyKeys,
      ]);
      return new Set(rows.map((r) => r.idempotency_key as string));
    },
    async recordRecipientThread(id, recipientThreadRef, at) {
      await query(
        `UPDATE deliveries
            SET recipient_thread_ref = $2,
                expired_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE expired_at END,
                delivered_at = COALESCE(delivered_at, $3)
          WHERE id = $1 AND destination->>'type' = 'principal'`,
        [id, recipientThreadRef, at],
      );
    },
    async listByRecipientThread(recipientThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      const rows = await q(
        `SELECT * FROM deliveries
          WHERE recipient_thread_ref = $1 AND destination->>'type' = 'principal'
          ORDER BY created_at DESC
          LIMIT $2`,
        [recipientThreadRef, limit],
      );
      return rows.map(rowToDelivery).reverse();
    },
    async listBySourceSession(sourceSessionId, sourceThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      const rows = await q(
        `SELECT * FROM deliveries
          WHERE provenance->>'sourceSessionId' = $1 OR provenance->>'sourceThreadRef' = $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [sourceSessionId, sourceThreadRef, limit],
      );
      return rows.map(rowToDelivery).reverse();
    },
    onEnqueue(listener) {
      return enqueueListeners.add(listener);
    },
  };
}
