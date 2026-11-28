import { tenantListeners } from "../tenants/cache.ts";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { Delivery, DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import { DELIVERY_MAX_AGE_MS, logDeliveryExpiry, type DeliveryStore } from "./delivery-store.ts";
import { pgTextSafe } from "../util/text.ts";
import { claimRows, claimThenLoad } from "../tenants/claim.ts";

const NOW_MS_SQL = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT";
const CLAIMABLE = `delivered_at IS NULL AND expired_at IS NULL AND NOT shadow
  AND (claim_expires_at IS NULL OR claim_expires_at <= ${NOW_MS_SQL})`;
const PENDING = "delivered_at IS NULL AND expired_at IS NULL AND NOT shadow";
const OVERAGED = `${CLAIMABLE} AND destination->'webTranscript'->>'kind' IS DISTINCT FROM 'slack_reply'
  AND created_at <= ${NOW_MS_SQL} - $1`;
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
    ...(r.recipient_thread_ref != null ? { recipientThreadRef: r.recipient_thread_ref as string } : {}),
    ...(r.deliver_latency_ms != null ? { deliverLatencyMs: Number(r.deliver_latency_ms) } : {}),
    ...(r.slack_api_ms != null ? { slackApiMs: Number(r.slack_api_ms) } : {}),
    ...(r.message_ts != null ? { messageTs: r.message_ts as string } : {}),
  };
}

export function createPostgresDeliveryStore(connectionString: string, opts?: { maxAgeMs?: number }): DeliveryStore {
  const maxAgeMs = opts?.maxAgeMs ?? DELIVERY_MAX_AGE_MS;
  const pg = createPgPool(connectionString);
  const { q, query } = pg;

  const enqueueListeners = tenantListeners<[string, string, string]>("delivery enqueue");

  const load = async (ids: string[]) =>
    (await q("SELECT * FROM deliveries WHERE id = ANY($1)", [ids])).map(rowToDelivery);

  async function get(id: string): Promise<Delivery | null> {
    const rows = await q("SELECT * FROM deliveries WHERE id = $1", [id]);
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async function expireOveraged(): Promise<void> {
    const rows = await q(
      `UPDATE deliveries
          SET expired_at = ${NOW_MS_SQL}
        WHERE id IN (SELECT id FROM deliveries WHERE ${OVERAGED} FOR UPDATE SKIP LOCKED)
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
        `INSERT INTO deliveries (id, idempotency_key, destination, text, attachments, provenance, created_at, shadow)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
           SET destination = EXCLUDED.destination,
               text = EXCLUDED.text,
               attachments = EXCLUDED.attachments,
               provenance = EXCLUDED.provenance,
               created_at = EXCLUDED.created_at,
               seq = DEFAULT,
               shadow = EXCLUDED.shadow,
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
        ],
      );
      if (inserted[0]) {
        if (input.shadow !== true)
          enqueueListeners.emit(input.destination.type, input.destination.target, String(inserted[0].tenant_id));
        return rowToDelivery(inserted[0]);
      }
      const existing = await q("SELECT * FROM deliveries WHERE idempotency_key = $1", [input.idempotencyKey]);
      if (!existing[0]) throw new Error(`delivery enqueue lost a race for key ${input.idempotencyKey}`);
      return rowToDelivery(existing[0]);
    },
    async pending(type, sourceThreadRef) {
      const rows = await q(
        `SELECT * FROM deliveries
          WHERE delivered_at IS NULL AND expired_at IS NULL AND NOT shadow AND destination->>'type' = $1
            AND ($2::text IS NULL OR provenance->>'sourceThreadRef' = $2)
          ORDER BY created_at, seq, id`,
        [type, sourceThreadRef ?? null],
      );
      return rows.map(rowToDelivery);
    },
    async claimPending(type, ttlMs) {
      await expireOveraged();
      const rows = await q(
        `WITH claimed AS (
           UPDATE deliveries SET claim_expires_at = ${NOW_MS_SQL} + $2
            WHERE id IN (
              SELECT id FROM deliveries WHERE ${CLAIMABLE} AND destination->>'type' = $1
               ORDER BY created_at, seq, id FOR UPDATE SKIP LOCKED)
            RETURNING *)
         SELECT * FROM claimed ORDER BY created_at, seq, id`,
        [type, ttlMs],
      );
      return rows.map(rowToDelivery);
    },
    async claimDue(type, ttlMs) {
      for (const d of await claimThenLoad(() => claimRows(pg, "expire_deliveries", [maxAgeMs]), load))
        logDeliveryExpiry(d, d.expiredAt ?? Date.now());
      const claimed = await claimThenLoad(() => claimRows(pg, "claim_deliveries", [type, ttlMs]), load);
      return claimed.sort((a, b) => a.createdAt - b.createdAt);
    },
    async claimHead(tenant, type, target, ttlMs) {
      const rows = await pg.forTenant(tenant).q(
        `WITH head AS (
           SELECT id, claim_expires_at FROM deliveries
            WHERE tenant_id = $1 AND ${PENDING} AND destination->>'type' = $2 AND destination->>'target' = $3
            ORDER BY created_at, seq, id LIMIT 1 FOR UPDATE)
         UPDATE deliveries d
            SET claim_expires_at = CASE WHEN head.claim_expires_at > ${NOW_MS_SQL}
              THEN head.claim_expires_at ELSE ${NOW_MS_SQL} + $4 END
           FROM head WHERE d.tenant_id = $1 AND d.id = head.id
         RETURNING d.*, head.claim_expires_at > ${NOW_MS_SQL} AS held`,
        [tenant.id, type, target, ttlMs],
      );
      const row = rows[0];
      if (!row) return null;
      const delivery = rowToDelivery(row);
      return row.held === true ? { delivery, heldUntil: Number(row.claim_expires_at) } : { delivery };
    },
    async defer(tenant, id, until) {
      await pg
        .forTenant(tenant)
        .query(
          "UPDATE deliveries SET claim_expires_at = $3 WHERE tenant_id = $1 AND id = $2 AND delivered_at IS NULL",
          [tenant.id, id, until],
        );
    },
    pendingHeads: async (types) =>
      (await claimRows(pg, "pending_delivery_heads", [types])).map(({ tenantId, id }) => {
        const [type, target] = JSON.parse(id) as [string, string];
        return { tenantId, type, target };
      }),
    undeliveredTenants: (type) => claimRows(pg, "undelivered_delivery_tenants", [type]),
    async listShadow(opts) {
      const limit = Math.max(1, opts?.limit ?? 100);
      const rows = await q(
        "SELECT * FROM deliveries WHERE shadow AND delivered_at IS NULL ORDER BY created_at DESC, seq DESC LIMIT $1",
        [limit],
      );
      return rows.map(rowToDelivery);
    },
    async ack(id, at, slackApiMs, messageTs) {
      await query(
        `UPDATE deliveries
            SET delivered_at = $2,
                expired_at = NULL,
                failed_reason = NULL,
                deliver_latency_ms = GREATEST(0, $2 - created_at),
                slack_api_ms = COALESCE($3, slack_api_ms),
                message_ts = COALESCE($4, message_ts)
          WHERE id = $1 AND delivered_at IS NULL`,
        [id, at, slackApiMs ?? null, messageTs ?? null],
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
                       expired_at = CASE WHEN deliveries.delivered_at IS NULL THEN NULL ELSE deliveries.expired_at END,
                       failed_reason = CASE WHEN deliveries.delivered_at IS NULL THEN NULL ELSE deliveries.failed_reason END`,
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
                failed_reason = CASE WHEN delivered_at IS NULL THEN NULL ELSE failed_reason END,
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
          ORDER BY created_at DESC, seq DESC
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
          ORDER BY created_at DESC, seq DESC
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
