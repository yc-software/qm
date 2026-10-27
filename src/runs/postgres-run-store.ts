import { createPgPool } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import { pgTextSafe } from "../util/text.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { Run, RunDeliveryState, RunPriority, RunStop, RunStore } from "./run-store.ts";
import { isTerminal } from "./run-store.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

/** The run rows; admission, cancellation and fencing come from the turn ledger (turns/turn-engine.ts). */
export type RunRows = Omit<RunStore, "enqueue" | "withdraw" | "cancelTurn" | "cancelTree" | "leaseHeld">;

export interface PostgresRuntime {
  runs: RunRows;
  ledger: ToolLedger;
  close(): Promise<void>;
}

export function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as Run["status"],
    request: JSON.parse(r.request as string) as OrchestratorInput,
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    turnUserSeq: r.turn_user_seq != null ? Number(r.turn_user_seq) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    priority: Number(r.claim_priority) as RunPriority,
    preemptions: Number(r.preemptions),
    leaseToken: (r.lease_token as string | null) ?? null,
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    lastStop: r.last_stop != null ? (JSON.parse(r.last_stop as string) as RunStop) : null,
    absurdQueue: (r.absurd_queue as string | null) ?? null,
    absurdTaskId: r.absurd_task_id == null ? null : String(r.absurd_task_id),
    absurdRunId: r.absurd_run_id == null ? null : String(r.absurd_run_id),
  };
}

const RUN_STORE_MIGRATIONS = [
  {
    id: "runs/store/0011-turn-engine",
    statements: [
      `SET LOCAL lock_timeout = '3s'`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_queue TEXT`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_task_id UUID`,
      `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_run_id UUID`,
    ],
  },
  {
    id: "runs/store/0012-turn-engine-indexes",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_in_flight ON runs(session_id, created_at, seq) WHERE status IN ('queued','pending','running')`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_queued ON runs(session_id, claim_priority, created_at, seq) WHERE status = 'queued'`,
    ],
  },
  {
    id: "runs/store/0013-turn-origin-backfill",
    statements: [
      `CREATE FUNCTION pg_temp.qm_turn_origin(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
          SELECT (r - 'triggered' - 'unprompted' - 'liveActor' - 'securityScreenData' - 'triggerDestination' - 'ownerKeychainUnion' - 'triggerTs' - 'entryTs')
            || jsonb_build_object('origin', COALESCE(r -> 'origin', jsonb_strip_nulls(CASE
              WHEN r -> 'triggered' = 'true' THEN jsonb_build_object('kind', 'automation', 'screenData', r -> 'securityScreenData',
                'destination', r -> 'triggerDestination', 'useOwnerKeychain', CASE WHEN r -> 'ownerKeychainUnion' = 'true' THEN 'true'::jsonb END)
              WHEN r -> 'unprompted' = 'true' THEN jsonb_build_object('kind', 'ambient', 'entryTs', to_jsonb(NULLIF(r ->> 'entryTs', '')),
                'live', CASE WHEN r -> 'liveActor' = 'true' THEN 'true'::jsonb END)
              WHEN r -> 'liveActor' = 'true' THEN jsonb_build_object('kind', 'human', 'messageTs', to_jsonb(NULLIF(r ->> 'triggerTs', '')),
                'entryTs', to_jsonb(NULLIF(r ->> 'entryTs', '')))
              ELSE '{"kind":"direct"}'::jsonb END)))
        $$`,
      `UPDATE runs SET request = pg_temp.qm_turn_origin(request::jsonb)::text WHERE strpos(request, '"origin":{"kind":') = 0`,
      `DO $$ BEGIN IF to_regclass('approvals') IS NOT NULL THEN UPDATE approvals SET json = jsonb_set(json, '{request}', pg_temp.qm_turn_origin(json -> 'request')) WHERE jsonb_typeof(json -> 'request') = 'object' AND NOT (json -> 'request') ? 'origin'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('run_signals') IS NOT NULL THEN UPDATE run_signals SET payload = jsonb_set(payload, '{request}', pg_temp.qm_turn_origin(payload -> 'request')) WHERE jsonb_typeof(payload -> 'request') = 'object' AND NOT (payload -> 'request') ? 'origin'; END IF; END $$`,
    ],
  },
  {
    id: "runs/store/0014-engine-default-absurd",
    statements: [`SET LOCAL lock_timeout = '3s'`, `ALTER TABLE runs ALTER COLUMN engine SET DEFAULT 'absurd'`],
  },
  {
    id: "runs/store/0015-settle-unclaimed-in-flight",
    statements: [
      `UPDATE runs SET status = 'failed', result = json_build_object('status', 'failed', 'sessionId', session_id, 'reason', 'This turn stopped unexpectedly and could not be resumed.')::text, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE engine = 'legacy' AND status IN ('pending', 'running')`,
    ],
  },
];

type Query = ReturnType<typeof createPgPool>["query"];

function runReads(
  q: Query,
): Pick<
  RunRows,
  | "getByDedupKey"
  | "latestForThreads"
  | "latestForThread"
  | "pendingReturns"
  | "terminalFinished"
  | "activeForThread"
  | "inFlightForThread"
  | "activeSessionIds"
  | "list"
> {
  return {
    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM runs WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async latestForThreads(threadRefs, opts) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT latest.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id
           AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true')
           ORDER BY created_at DESC, seq DESC LIMIT 1
         ) latest`,
        [[...new Set(threadRefs)], Boolean(opts?.excludePrivateMessages)],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
    async latestForThread(threadRef, opts) {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true') ORDER BY created_at DESC, seq DESC LIMIT 1",
        [threadRef, Boolean(opts?.excludePrivateMessages)],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },
    async pendingReturns(limit = 100, afterId = "") {
      const { rows } = await q(
        `SELECT * FROM (
           SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM runs wake JOIN runs child
           ON child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status IN ('pending','queued') AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending WHERE retry_after <= $3 ORDER BY id LIMIT $1`,
        [limit, afterId, Date.now()],
      );
      return rows.map(rowToRun);
    },
    async terminalFinished(after, beforeMs, limit) {
      const { rows } = await q(
        `SELECT * FROM runs WHERE status IN ('done','failed') AND finished_at <= $1
           AND (finished_at > $2 OR (finished_at = $2 AND id > $3))
         ORDER BY finished_at, id LIMIT $4`,
        [beforeMs, after.finishedAt, after.id, limit],
      );
      return rows.map(rowToRun);
    },
    async activeForThread(sessionId: string): Promise<Run | null> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC LIMIT 1",
        [sessionId],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC",
        [sessionId],
      );
      return rows.map(rowToRun);
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await q("SELECT DISTINCT session_id FROM runs WHERE status IN ('queued','pending','running')");
      return rows.map((r) => r.session_id as string);
    },

    async list({ limit = 200, threadRef }: { limit?: number; threadRef?: string } = {}): Promise<Run[]> {
      const { rows } = threadRef
        ? await q(
            "SELECT * FROM runs WHERE session_id = $1 OR starts_with(session_id, $1 || ':task:') OR starts_with(session_id, $1 || ':status:') ORDER BY created_at DESC LIMIT $2",
            [threadRef, limit],
          )
        : await q("SELECT * FROM runs ORDER BY created_at DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },
  };
}

function createToolLedger(q: Query): ToolLedger {
  return {
    async begin(runId, attempt, callIndex): Promise<LedgerBegin> {
      const { rows } = await q("SELECT output FROM tool_calls WHERE run_id=$1 AND attempt=$2 AND call_index=$3", [
        runId,
        attempt,
        callIndex,
      ]);
      return rows[0] ? { cached: true, output: rows[0].output as string } : { cached: false };
    },
    async record(runId, attempt, callIndex, output): Promise<void> {
      await q(
        "INSERT INTO tool_calls(run_id, attempt, call_index, output, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [runId, attempt, callIndex, output, Date.now()],
      );
    },
  };
}

export function createPostgresRunStore(connectionString: string): PostgresRuntime {
  const { query: q, close: closePool } = createPgPool(connectionString, RUN_STORE_MIGRATIONS);

  async function getRun(id: string): Promise<Run | null> {
    const { rows } = await q("SELECT * FROM runs WHERE id = $1", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }
  const terminalListeners: Array<(run: Run) => void> = [];
  function settle(run: Run | null): void {
    if (!run || !isTerminal(run.status)) return;
    for (const listener of terminalListeners) listener(run);
  }
  const runs: RunRows = {
    ...runReads(q),
    async noteTurnUserSeq(runId: string, seq: number): Promise<boolean> {
      const { rowCount } = await q("UPDATE runs SET turn_user_seq=$2 WHERE id=$1 AND turn_user_seq IS NULL", [
        runId,
        seq,
      ]);
      return rowCount > 0;
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2",
              [JSON.stringify(state), runId],
            )
          : await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2 AND lease_token=$3",
              [JSON.stringify(state), runId, leaseToken],
            );
      return rowCount > 0;
    },

    async markReturned(runId) {
      await q("UPDATE runs SET returned_at = $2 WHERE id = $1 AND status IN ('done','failed')", [runId, Date.now()]);
    },
    async deferReturn(runId, delayMs) {
      await q("UPDATE runs SET retry_after = $2 WHERE id = $1 AND status IN ('done','failed')", [
        runId,
        Date.now() + Math.max(0, delayMs),
      ]);
    },
    onTerminal(listener): void {
      terminalListeners.push(listener);
    },
    emitTerminal: settle,

    get: getRun,

    async editPendingText(runId: string, text: string, expectedText: string): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE runs SET request = (request::jsonb || jsonb_build_object('text', $2::text, 'displayText', $2::text))::text
         WHERE id = $1 AND status IN ('queued','pending') AND attempts = 0 AND turn_user_seq IS NULL
         AND COALESCE(request::jsonb ->> 'displayText', request::jsonb ->> 'text') = $3`,
        [runId, pgTextSafe(text), pgTextSafe(expectedText)],
      );
      return (rowCount ?? 0) > 0;
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.hasDedupeKey(signal.dedupeKey!);
      const { rows } = await q(
        `WITH target AS (
           SELECT id FROM runs WHERE id=$2 AND status IN ('queued','pending','running') FOR UPDATE
         ), moved AS (
           DELETE FROM runs WHERE id=$1 AND id<>$2 AND status='queued'
           AND COALESCE(request::jsonb->>'displayText',request::jsonb->>'text') = $5::jsonb->'request'->>'text'
           AND EXISTS (SELECT 1 FROM target) RETURNING id
         ), sent AS (
           INSERT INTO run_signals(run_id,kind,text,payload,created_at,dedupe_key)
           SELECT $2,$3,$4,$5,$6,$7 FROM moved RETURNING id
         ) SELECT pg_notify('run_signals',$2) FROM sent`,
        [
          queuedRunId,
          targetRunId,
          signal.kind,
          signal.text === undefined ? null : pgTextSafe(signal.text),
          jsonbStringify(signal),
          Date.now(),
          signal.dedupeKey ?? null,
        ],
      );
      return rows.length > 0;
    },

    close: () => closePool(),
  };

  return { runs, ledger: createToolLedger(q), close: () => runs.close!() };
}
