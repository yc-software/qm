import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import type { PeerDelivery, PeerMessage } from "./types.ts";
import type { BoardPage, MessageBoardStore } from "./message-board.ts";

const MIGRATION = {
  id: "coordination/board/0001",
  expectedChecksum: "2d1abf4f630c58048de7156f33c0b66f41ce3259ce612e7305c24ccdb3b3ce62",
  statements: [
    `CREATE TABLE IF NOT EXISTS peer_messages(
      id TEXT PRIMARY KEY,
      seq BIGSERIAL NOT NULL,
      org_id TEXT NOT NULL,
      sender_session_id TEXT NOT NULL,
      sender_run_id TEXT,
      text TEXT NOT NULL,
      audience_expr TEXT,
      resolved_recipient_ids TEXT[] NOT NULL DEFAULT '{}',
      reply_to TEXT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_peer_messages_org_seq ON peer_messages(org_id, seq)`,
    `CREATE TABLE IF NOT EXISTS peer_deliveries(
      message_id TEXT NOT NULL,
      recipient_session_id TEXT NOT NULL,
      run_id TEXT,
      dispatched_at BIGINT,
      consumed_at BIGINT,
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at BIGINT,
      last_status TEXT,
      last_reason TEXT,
      PRIMARY KEY (message_id, recipient_session_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_peer_deliveries_due
      ON peer_deliveries(next_attempt_at) WHERE dispatched_at IS NULL AND next_attempt_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_peer_deliveries_unconsumed
      ON peer_deliveries(message_id, recipient_session_id) WHERE dispatched_at IS NOT NULL AND consumed_at IS NULL`,
  ],
};

function rowToMessage(row: Record<string, unknown>): PeerMessage {
  return {
    id: row.id as string,
    seq: Number(row.seq),
    orgId: row.org_id as string,
    senderSessionId: row.sender_session_id as string,
    senderRunId: (row.sender_run_id as string | null) ?? null,
    text: row.text as string,
    audienceExpr: (row.audience_expr as string | null) ?? null,
    resolvedRecipientIds: (row.resolved_recipient_ids as string[] | null) ?? [],
    replyTo: (row.reply_to as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

function rowToDelivery(row: Record<string, unknown>): PeerDelivery {
  return {
    messageId: row.message_id as string,
    recipientSessionId: row.recipient_session_id as string,
    runId: (row.run_id as string | null) ?? null,
    dispatchedAt: row.dispatched_at === null ? null : Number(row.dispatched_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lastStatus: (row.last_status as string | null) ?? null,
    lastReason: (row.last_reason as string | null) ?? null,
  };
}

export function createPostgresMessageBoardStore(connectionString: string): MessageBoardStore {
  const pg = createPgPool(connectionString, [MIGRATION]);
  const q = (text: string, params?: unknown[]): Promise<Rows> => pg.q(text, params);

  return {
    async publish(input) {
      const rows = await q(
        `WITH m AS (
           INSERT INTO peer_messages(id, org_id, sender_session_id, sender_run_id, text, audience_expr,
                                     resolved_recipient_ids, reply_to, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
           RETURNING id, seq, org_id, sender_session_id, sender_run_id, text, audience_expr,
                     resolved_recipient_ids, reply_to, created_at
         ), d AS (
           INSERT INTO peer_deliveries(message_id, recipient_session_id, next_attempt_at)
           SELECT m.id, recipient, $9 FROM m, unnest($7::text[]) AS recipient
           RETURNING 1
         )
         SELECT * FROM m`,
        [
          input.id,
          input.orgId,
          input.senderSessionId,
          input.senderRunId,
          input.text,
          input.audienceExpr,
          input.resolvedRecipientIds,
          input.replyTo,
          input.createdAt,
        ],
      );
      return rowToMessage(rows[0]!);
    },
    async get(orgId, messageId) {
      const rows = await q(`SELECT * FROM peer_messages WHERE id = $1 AND org_id = $2`, [messageId, orgId]);
      return rows[0] ? rowToMessage(rows[0]) : null;
    },
    async list(orgId, opts): Promise<BoardPage> {
      const rows = await q(`SELECT * FROM peer_messages WHERE org_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`, [
        orgId,
        opts.afterSeq ?? 0,
        opts.limit,
      ]);
      const messages = rows.map(rowToMessage);
      return { messages, nextCursor: messages.length === opts.limit ? (messages.at(-1)?.seq ?? null) : null };
    },
    async deliveries(messageId) {
      const rows = await q(`SELECT * FROM peer_deliveries WHERE message_id = $1 ORDER BY recipient_session_id ASC`, [
        messageId,
      ]);
      return rows.map(rowToDelivery);
    },
    async claimDue(opts) {
      const rows = await q(
        `UPDATE peer_deliveries SET next_attempt_at = $1, attempts = attempts + 1
           WHERE (message_id, recipient_session_id) IN (
             SELECT message_id, recipient_session_id FROM peer_deliveries
               WHERE dispatched_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2
               ORDER BY next_attempt_at ASC, message_id ASC, recipient_session_id ASC
               LIMIT $3 FOR UPDATE SKIP LOCKED
           )
           RETURNING *`,
        [opts.now + opts.leaseMs, opts.now, opts.limit],
      );
      return rows.map(rowToDelivery);
    },
    async retire(messageId, recipientSessionId, retirement) {
      await q(
        `UPDATE peer_deliveries
           SET run_id = COALESCE($3, run_id), dispatched_at = $4, consumed_at = $5,
               next_attempt_at = NULL, last_status = $6
           WHERE message_id = $1 AND recipient_session_id = $2`,
        [
          messageId,
          recipientSessionId,
          retirement.runId,
          retirement.dispatchedAt,
          retirement.consumedAt,
          retirement.lastStatus,
        ],
      );
    },
    async park(messageId, recipientSessionId, parked) {
      await q(
        `UPDATE peer_deliveries SET next_attempt_at = $3, last_status = $4, last_reason = $5
           WHERE message_id = $1 AND recipient_session_id = $2`,
        [messageId, recipientSessionId, parked.nextAttemptAt, parked.lastStatus, parked.lastReason],
      );
    },
    async awaitingConsumption(limit) {
      const rows = await q(
        `SELECT * FROM peer_deliveries
           WHERE dispatched_at IS NOT NULL AND consumed_at IS NULL AND run_id IS NOT NULL
           ORDER BY message_id ASC, recipient_session_id ASC LIMIT $1`,
        [limit],
      );
      return rows.map(rowToDelivery);
    },
    async markConsumed(messageId, recipientSessionId, at) {
      await q(`UPDATE peer_deliveries SET consumed_at = $3 WHERE message_id = $1 AND recipient_session_id = $2`, [
        messageId,
        recipientSessionId,
        at,
      ]);
    },
    close: () => pg.close(),
  };
}
