import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type {
  IncidentListOptions,
  OperatorIncident,
  OperatorIncidentSeverity,
  OperatorIncidentSource,
  OperatorIncidentStatus,
  OperatorIncidentStore,
} from "./incident-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS operator_incidents(
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    code TEXT NOT NULL,
    intentional BOOLEAN NOT NULL,
    discrepancy BOOLEAN NOT NULL,
    occurred_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    scope_label TEXT NOT NULL,
    session_id TEXT,
    run_id TEXT,
    actor_label TEXT,
    surface TEXT,
    request_summary TEXT,
    backend_message TEXT NOT NULL,
    reply_summary TEXT,
    started_at BIGINT,
    finished_at BIGINT,
    duration_ms BIGINT,
    attempts INT,
    tool_failure_count INT,
    backend_error_count INT,
    notification_requested BOOLEAN NOT NULL DEFAULT FALSE,
    notification_delivery_id TEXT,
    notification_queued_at BIGINT,
    notification_delivered_at BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_by_occurred ON operator_incidents(occurred_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_by_scope_occurred
    ON operator_incidents(scope_label, occurred_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_by_session_occurred
    ON operator_incidents(session_id, occurred_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_pending_notification
    ON operator_incidents(occurred_at, id) WHERE notification_requested AND notification_queued_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_pending_receipt
    ON operator_incidents(notification_queued_at, id)
    WHERE notification_delivery_id IS NOT NULL AND notification_delivered_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS operator_incidents_pending_escalation
    ON operator_incidents(occurred_at, id)
    WHERE source='backend' AND status='open' AND NOT notification_requested`,
];

const COLUMNS = `id, idempotency_key, source, severity, status, category, code, intentional, discrepancy,
  occurred_at, created_at, updated_at, scope_label, session_id, run_id, actor_label, surface, request_summary,
  backend_message, reply_summary, started_at, finished_at, duration_ms, attempts, tool_failure_count,
  backend_error_count, notification_requested, notification_delivery_id, notification_queued_at,
  notification_delivered_at`;

function rowToIncident(row: Record<string, unknown>): OperatorIncident {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    source: row.source as OperatorIncidentSource,
    severity: row.severity as OperatorIncidentSeverity,
    status: row.status as OperatorIncidentStatus,
    category: row.category as string,
    code: row.code as string,
    intentional: row.intentional as boolean,
    discrepancy: row.discrepancy as boolean,
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    scopeLabel: row.scope_label as string,
    ...(row.session_id != null ? { sessionId: row.session_id as string } : {}),
    ...(row.run_id != null ? { runId: row.run_id as string } : {}),
    ...(row.actor_label != null ? { actorLabel: row.actor_label as string } : {}),
    ...(row.surface != null ? { surface: row.surface as string } : {}),
    ...(row.request_summary != null ? { requestSummary: row.request_summary as string } : {}),
    backendMessage: row.backend_message as string,
    ...(row.reply_summary != null ? { replySummary: row.reply_summary as string } : {}),
    ...(row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at != null ? { finishedAt: Number(row.finished_at) } : {}),
    ...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
    ...(row.attempts != null ? { attempts: Number(row.attempts) } : {}),
    ...(row.tool_failure_count != null ? { toolFailureCount: Number(row.tool_failure_count) } : {}),
    ...(row.backend_error_count != null ? { backendErrorCount: Number(row.backend_error_count) } : {}),
    notificationRequested: row.notification_requested as boolean,
    ...(row.notification_delivery_id != null ? { notificationDeliveryId: row.notification_delivery_id as string } : {}),
    ...(row.notification_queued_at != null ? { notificationQueuedAt: Number(row.notification_queued_at) } : {}),
    ...(row.notification_delivered_at != null
      ? { notificationDeliveredAt: Number(row.notification_delivered_at) }
      : {}),
  };
}

function filters(opts: IncidentListOptions): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (opts.scopeId !== undefined) add("scope_label = ?", opts.scopeId);
  if (opts.sessionId !== undefined) add("session_id = ?", opts.sessionId);
  if (opts.status !== undefined) add("status = ?", opts.status);
  if (opts.severity !== undefined) add("severity = ?", opts.severity);
  if (opts.source !== undefined) add("source = ?", opts.source);
  if (opts.before) {
    params.push(opts.before.occurredAt, opts.before.id);
    clauses.push(`(occurred_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createPostgresOperatorIncidentStore(
  connectionString: string,
  now: () => number = Date.now,
): OperatorIncidentStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const q = pg.query;

  return {
    async record(input) {
      const at = now();
      const values = [
        input.id ?? randomUUID(),
        input.idempotencyKey,
        input.source,
        input.severity,
        input.status,
        input.category,
        input.code,
        input.intentional,
        input.discrepancy,
        input.occurredAt,
        at,
        at,
        input.scopeLabel,
        input.sessionId ?? null,
        input.runId ?? null,
        input.actorLabel ?? null,
        input.surface ?? null,
        input.requestSummary ?? null,
        input.backendMessage,
        input.replySummary ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.durationMs ?? null,
        input.attempts ?? null,
        input.toolFailureCount ?? null,
        input.backendErrorCount ?? null,
        input.notificationRequested,
      ];
      const placeholders = values.map((_, i) => `$${i + 1}`).join(",");
      const { rows } = await q(
        `INSERT INTO operator_incidents(
          id, idempotency_key, source, severity, status, category, code, intentional, discrepancy,
          occurred_at, created_at, updated_at, scope_label, session_id, run_id, actor_label, surface,
          request_summary, backend_message, reply_summary, started_at, finished_at, duration_ms, attempts,
          tool_failure_count, backend_error_count, notification_requested
        ) VALUES (${placeholders})
        ON CONFLICT (idempotency_key) DO UPDATE SET
          notification_requested = operator_incidents.notification_requested OR EXCLUDED.notification_requested
        RETURNING ${COLUMNS}`,
        values,
      );
      return rowToIncident(rows[0]!);
    },
    async get(id) {
      const { rows } = await q(`SELECT ${COLUMNS} FROM operator_incidents WHERE id=$1`, [id]);
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async list(opts = {}) {
      const { where, params } = filters(opts);
      params.push(Math.max(1, Math.min(500, opts.limit ?? 100)));
      const { rows } = await q(
        `SELECT ${COLUMNS} FROM operator_incidents${where}
         ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToIncident);
    },
    async count(opts = {}) {
      const { where, params } = filters(opts);
      const { rows } = await q(`SELECT COUNT(*)::bigint AS total FROM operator_incidents${where}`, params);
      return Number(rows[0]?.total ?? 0);
    },
    async pendingNotifications(limit = 50) {
      const { rows } = await q(
        `SELECT ${COLUMNS} FROM operator_incidents
         WHERE notification_requested AND notification_queued_at IS NULL
         ORDER BY occurred_at, id LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return rows.map(rowToIncident);
    },
    async pendingReceipts(limit = 50) {
      const { rows } = await q(
        `SELECT ${COLUMNS} FROM operator_incidents
         WHERE notification_delivery_id IS NOT NULL AND notification_delivered_at IS NULL
         ORDER BY notification_queued_at, id LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return rows.map(rowToIncident);
    },
    async pendingEscalations(before, limit = 50) {
      const { rows } = await q(
        `SELECT ${COLUMNS} FROM operator_incidents
         WHERE source='backend' AND status='open' AND NOT notification_requested AND occurred_at <= $1
         ORDER BY occurred_at, id LIMIT $2`,
        [before, Math.max(1, Math.min(200, limit))],
      );
      return rows.map(rowToIncident);
    },
    async requestNotification(id, at) {
      const { rows } = await q(
        `UPDATE operator_incidents SET notification_requested=TRUE, updated_at=$2
         WHERE id=$1 AND status='open' RETURNING ${COLUMNS}`,
        [id, at],
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async markStatus(id, status, at) {
      const { rows } = await q(
        `UPDATE operator_incidents SET status=$2, updated_at=$3 WHERE id=$1 RETURNING ${COLUMNS}`,
        [id, status, at],
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async markNotificationQueued(id, deliveryId, at) {
      const { rows } = await q(
        `UPDATE operator_incidents
         SET notification_delivery_id=$2, notification_queued_at=$3, updated_at=$3
         WHERE id=$1 AND notification_queued_at IS NULL RETURNING ${COLUMNS}`,
        [id, deliveryId, at],
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    async markNotificationDelivered(id, at) {
      const { rows } = await q(
        `UPDATE operator_incidents SET notification_delivered_at=$2, updated_at=$2
         WHERE id=$1 AND notification_delivered_at IS NULL RETURNING ${COLUMNS}`,
        [id, at],
      );
      return rows[0] ? rowToIncident(rows[0]) : null;
    },
    close: () => pg.close(),
  };
}
