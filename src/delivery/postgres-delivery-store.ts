import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type { Delivery, DeliveryProvenance, Destination, OutgoingAttachment } from "../types.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import { LEGACY_CRON_ID_PATTERN, STABLE_CRON_ID_PATTERN } from "../sessions/session-store.ts";

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
    ...(r.shadow === true ? { shadow: true } : {}),
    ...(r.recipient_thread_ref != null ? { recipientThreadRef: r.recipient_thread_ref as string } : {}),
    ...(r.deliver_latency_ms != null ? { deliverLatencyMs: Number(r.deliver_latency_ms) } : {}),
    ...(r.slack_api_ms != null ? { slackApiMs: Number(r.slack_api_ms) } : {}),
  };
}

export function createPostgresDeliveryStore(connectionString: string): DeliveryStore {
  const { q, query } = createPgPool(connectionString, [
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
  ]);

  const enqueueListeners = new Set<() => void>();

  return {
    async enqueue(input) {
      const inserted = await q(
        `INSERT INTO deliveries (id, idempotency_key, destination, text, attachments, provenance, created_at, shadow)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.idempotencyKey,
          JSON.stringify(input.destination),
          input.text,
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          input.provenance ? JSON.stringify(input.provenance) : null,
          Date.now(),
          input.shadow === true,
        ],
      );
      if (inserted[0]) {
        if (input.shadow !== true) for (const l of enqueueListeners) l();
        return rowToDelivery(inserted[0]);
      }
      const existing = await q("SELECT * FROM deliveries WHERE idempotency_key = $1", [input.idempotencyKey]);
      if (!existing[0]) throw new Error(`delivery enqueue lost a race for key ${input.idempotencyKey}`);
      return rowToDelivery(existing[0]);
    },
    async pending(type) {
      const rows = await q(
        "SELECT * FROM deliveries WHERE delivered_at IS NULL AND NOT shadow AND destination->>'type' = $1 ORDER BY created_at",
        [type],
      );
      return rows.map(rowToDelivery);
    },
    async claimPending(type, ttlMs) {
      const rows = await q(
        `UPDATE deliveries
            SET claim_expires_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT + $2
          WHERE id IN (
            SELECT id FROM deliveries
             WHERE delivered_at IS NULL AND NOT shadow AND destination->>'type' = $1
               AND (claim_expires_at IS NULL
                 OR claim_expires_at <= (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
             ORDER BY created_at
               FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [type, ttlMs],
      );
      return rows.map(rowToDelivery).sort((a, b) => a.createdAt - b.createdAt);
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
                deliver_latency_ms = GREATEST(0, $2 - created_at),
                slack_api_ms = COALESCE($3, slack_api_ms)
          WHERE id = $1 AND delivered_at IS NULL`,
        [id, at, slackApiMs ?? null],
      );
    },
    async ackByKey(idempotencyKey, at) {
      await query(
        `INSERT INTO deliveries (id, idempotency_key, destination, text, created_at, delivered_at)
         VALUES ($1, $2, '{"type":"ack-tombstone","target":""}', '', $3, $3)
         ON CONFLICT (idempotency_key)
         DO UPDATE SET delivered_at = COALESCE(deliveries.delivered_at, EXCLUDED.delivered_at)`,
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
    async get(id) {
      const rows = await q("SELECT * FROM deliveries WHERE id = $1", [id]);
      return rows[0] ? rowToDelivery(rows[0]) : null;
    },
    async recordRecipientThread(id, recipientThreadRef, at) {
      await query(
        `UPDATE deliveries
            SET recipient_thread_ref = $2,
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
    async sentCountsBySourceSessions(sources) {
      const counts = new Map<string, number>();
      if (!sources.length) return counts;
      const byThreadRef = new Map(sources.map((s) => [s.threadRef, s.sessionId]));
      const rows = await q(
        `SELECT provenance->>'sourceSessionId' AS session_id,
                provenance->>'sourceThreadRef' AS thread_ref,
                COUNT(*)::int AS sent
           FROM deliveries
          WHERE NOT shadow
            AND (provenance->>'sourceSessionId' = ANY($1)
              OR (provenance->>'sourceSessionId' IS NULL AND provenance->>'sourceThreadRef' = ANY($2)))
          GROUP BY 1, 2`,
        [sources.map((s) => s.sessionId), sources.map((s) => s.threadRef)],
      );
      for (const r of rows as Array<{ session_id: string | null; thread_ref: string | null; sent: number }>) {
        const id = r.session_id ?? (r.thread_ref ? byThreadRef.get(r.thread_ref) : undefined);
        if (id) counts.set(id, (counts.get(id) ?? 0) + Number(r.sent));
      }
      return counts;
    },
    async sentRunCountsByCron(cronIds) {
      const counts = new Map<string, number>();
      if (!cronIds.length) return counts;
      const rows = await q(
        `SELECT d.cron_id, COUNT(DISTINCT d.run)::int AS runs
           FROM (SELECT COALESCE(substring(provenance->>'sourceThreadRef' FROM '${STABLE_CRON_ID_PATTERN}'),
                                 substring(provenance->>'sourceThreadRef' FROM '${LEGACY_CRON_ID_PATTERN}')) AS cron_id,
                        COALESCE(provenance->>'sourceSessionId', provenance->>'sourceThreadRef') AS run
                   FROM deliveries
                  WHERE NOT shadow AND provenance->>'sourceThreadRef' IS NOT NULL) d
          WHERE d.cron_id = ANY($1)
          GROUP BY d.cron_id`,
        [cronIds],
      );
      for (const r of rows as Array<{ cron_id: string; runs: number }>) counts.set(r.cron_id, Number(r.runs));
      return counts;
    },
    onEnqueue(listener) {
      enqueueListeners.add(listener);
      return () => enqueueListeners.delete(listener);
    },
  };
}
