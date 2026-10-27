import { readFileSync } from "node:fs";
import { createPgPool, type PgMigrationDefinition, type PgPool } from "../persistence/pg-pool.ts";

export const TURN_QUEUES = ["turns_people", "turns_delegated", "turns_background"] as const;
export type TurnQueue = (typeof TURN_QUEUES)[number];
export const JOB_QUEUE = "jobs";
export type AbsurdQueue = TurnQueue | typeof JOB_QUEUE;
export const ABSURD_QUEUES: readonly AbsurdQueue[] = [...TURN_QUEUES, JOB_QUEUE];

export const ABSURD_SQL_URL = new URL("./absurd.sql", import.meta.url);

const queueSetup = (queue: string): string[] => [
  `SELECT absurd.create_queue('${queue}', 'unpartitioned')`,
  `SELECT absurd.set_queue_policy('${queue}', '{"cleanup_ttl":"7 days"}'::jsonb)`,
];

export const ABSURD_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0.5.1",
  script: true,
  statements: [readFileSync(ABSURD_SQL_URL, "utf8"), ...TURN_QUEUES.flatMap(queueSetup)],
  expectedChecksum: "1ff2d7e74b5a2b0454ec1ccea7f29fdf48fc58cbe89dc8e9f8f9e896ea5c8a2b",
  acceptedChecksums: [
    "4f8dd2e6249339a7c89d650d4d71b5a04228cf329a45f515a834acdeca3864e9",
    "0c43a7c73f71963654a5bb378cd6aa711d18d4e1bb16990631b63db62a8ad1e1",
  ],
};

const RETIRED_FUNCTIONS = [
  "uuidv7_timestamp",
  "uuidv7_floor",
  "week_bucket_utc",
  "partition_week_tag",
  "ensure_partitions",
  "list_detach_candidates",
  "drop_detached_partition",
  "schedule_detach_jobs",
  "enable_cron",
  "disable_cron",
];

export const ABSURD_UNPARTITIONED_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0.5.1-unpartitioned",
  script: true,
  statements: [
    ...RETIRED_FUNCTIONS.map((name) => `DROP FUNCTION IF EXISTS absurd.${name}`),
    readFileSync(ABSURD_SQL_URL, "utf8"),
  ],
};

export const ABSURD_JOBS_MIGRATION: PgMigrationDefinition = {
  id: "absurd/jobs-queue",
  statements: queueSetup(JOB_QUEUE),
};

const TASK_COLUMNS =
  "task_id, task_name, params, headers, retry_strategy, max_attempts, cancellation, enqueue_at, first_started_at, " +
  "state, attempts, last_attempt_run, completed_payload, cancelled_at, idempotency_key";

export const MERGE_TENANT_QUEUES = `DO $merge$
DECLARE
  q record;
  base text;
  owner text;
  moved integer;
  total integer;
  gone boolean;
BEGIN
  FOR q IN SELECT queue_name FROM absurd.queues
    WHERE queue_name ~ '^(turns_people|turns_delegated|turns_background|jobs)_t[0-9a-f]{12}$' ORDER BY queue_name
  LOOP
    base := regexp_replace(q.queue_name, '_t[0-9a-f]{12}$', '');
    gone := false;
    LOOP
      BEGIN
        EXECUTE format('LOCK TABLE absurd.%I, absurd.%I, absurd.%I, absurd.%I, absurd.%I IN ACCESS EXCLUSIVE MODE NOWAIT',
          'r_' || q.queue_name, 't_' || q.queue_name, 'w_' || q.queue_name, 'c_' || q.queue_name, 'e_' || q.queue_name);
        EXIT;
      EXCEPTION
        WHEN lock_not_available THEN PERFORM pg_sleep(0.05);
        WHEN undefined_table THEN gone := true; EXIT;
      END;
    END LOOP;
    CONTINUE WHEN gone;
    SELECT t.id::text INTO owner FROM tenants t
      WHERE left(replace(t.id::text, '-', ''), 12) = right(q.queue_name, 12);
    EXECUTE format(
      'WITH moved AS (INSERT INTO absurd.%1$I (${TASK_COLUMNS})
         SELECT task_id, task_name, params,
           COALESCE(headers, ''{}'') || jsonb_build_object(''tenantId'', COALESCE(params->>''tenantId'', $1)),
           retry_strategy, max_attempts, cancellation, enqueue_at, first_started_at, state, attempts,
           last_attempt_run, completed_payload, cancelled_at,
           CASE WHEN $2 THEN idempotency_key ELSE ''tenant:'' || $1 || '':'' || idempotency_key END
         FROM absurd.%2$I WHERE $2 OR ($1 IS NOT NULL AND task_name NOT LIKE ''every:%%'')
         RETURNING 1)
       SELECT count(*) FROM moved', 't_' || base, 't_' || q.queue_name)
      INTO moved USING owner, base <> 'jobs';
    EXECUTE format('SELECT count(*) FROM absurd.%I', 't_' || q.queue_name) INTO total;
    EXECUTE format('INSERT INTO absurd.%1$I SELECT * FROM absurd.%2$I s
      WHERE EXISTS (SELECT 1 FROM absurd.%3$I t WHERE t.task_id = s.task_id)',
      'r_' || base, 'r_' || q.queue_name, 't_' || base);
    EXECUTE format('INSERT INTO absurd.%1$I SELECT * FROM absurd.%2$I s
      WHERE EXISTS (SELECT 1 FROM absurd.%3$I t WHERE t.task_id = s.task_id)',
      'c_' || base, 'c_' || q.queue_name, 't_' || base);
    EXECUTE format('INSERT INTO absurd.%1$I SELECT * FROM absurd.%2$I s
      WHERE EXISTS (SELECT 1 FROM absurd.%3$I t WHERE t.task_id = s.task_id)',
      'w_' || base, 'w_' || q.queue_name, 't_' || base);
    EXECUTE format('INSERT INTO absurd.%1$I SELECT * FROM absurd.%2$I ON CONFLICT DO NOTHING',
      'e_' || base, 'e_' || q.queue_name);
    PERFORM absurd.drop_queue(q.queue_name);
    RAISE INFO 'moved % of % task(s) from % into %', moved, total, q.queue_name, base;
  END LOOP;
END
$merge$`;

export async function mergeTenantQueues(connectionString: string): Promise<void> {
  const client = await (await registerAbsurdSchema(connectionString).pool()).connect();
  const log = (notice: { severity?: string; message?: string }) => {
    if (notice.severity === "INFO") console.log(`[absurd] ${notice.message ?? ""}`);
  };
  client.on("notice", log);
  try {
    await client.query(MERGE_TENANT_QUEUES);
  } finally {
    client.off("notice", log);
    client.release();
  }
}

export function registerAbsurdSchema(connectionString: string): PgPool {
  return createPgPool(connectionString, [ABSURD_MIGRATION, ABSURD_UNPARTITIONED_MIGRATION, ABSURD_JOBS_MIGRATION]);
}
