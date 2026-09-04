import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import type {
  OpenTaskFilter,
  Task,
  TaskEvent,
  TaskEventType,
  TaskFilter,
  TaskStatus,
  TaskStore,
} from "./task-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    origin_run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'failed')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_session_open
    ON tasks(session_id, created_at, id) WHERE status IN ('pending', 'in_progress')`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_origin_run_open
    ON tasks(origin_run_id, created_at, id) WHERE status IN ('pending', 'in_progress')`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_origin_run
    ON tasks(origin_run_id, created_at, id)`,
  `CREATE TABLE IF NOT EXISTS task_events(
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('created', 'status_changed')),
    from_status TEXT,
    to_status TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `DO $$ BEGIN
    ALTER TABLE tasks ADD CONSTRAINT tasks_session_id_cascade_fkey
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_task_id_fkey;
  EXCEPTION WHEN undefined_table THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE task_events ADD CONSTRAINT task_events_task_id_cascade_fkey
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id)`,
];

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    originRunId: row.origin_run_id as string,
    title: row.title as string,
    status: row.status as TaskStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToEvent(row: Record<string, unknown>): TaskEvent {
  return {
    id: String(row.id),
    taskId: row.task_id as string,
    runId: row.run_id as string,
    type: row.type as TaskEventType,
    fromStatus: row.from_status === null ? null : (row.from_status as TaskStatus),
    toStatus: row.to_status as TaskStatus,
    createdAt: Number(row.created_at),
  };
}

function filterSql(filter: TaskFilter | OpenTaskFilter, open: boolean): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };
  if (filter.sessionId !== undefined) add("session_id = ?", filter.sessionId);
  if (filter.originRunId !== undefined) add("origin_run_id = ?", filter.originRunId);
  if (open) clauses.push("status IN ('pending', 'in_progress')");
  if (!open && "statuses" in filter && filter.statuses !== undefined) add("status = ANY(?)", [...filter.statuses]);
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createPostgresTaskStore(connectionString: string, opts: { now?: () => number } = {}): TaskStore {
  const now = opts.now ?? (() => Date.now());
  const pg = createPgPool(connectionString, SCHEMA);
  const q = pg.query;

  return {
    async create(input): Promise<Task> {
      const id = input.id ?? randomUUID();
      const at = now();
      const status = input.status ?? "pending";
      const client = await (await pg.pool()).connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO tasks(id, session_id, origin_run_id, title, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
          [id, input.sessionId, input.originRunId, input.title, status, at],
        );
        await client.query(
          `INSERT INTO task_events(task_id, run_id, type, from_status, to_status, created_at)
           VALUES ($1,$2,'created',NULL,$3,$4)`,
          [id, input.originRunId, status, at],
        );
        await client.query("COMMIT");
        return rowToTask(inserted.rows[0] as Record<string, unknown>);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async get(id): Promise<Task | null> {
      const { rows } = await q("SELECT * FROM tasks WHERE id = $1", [id]);
      return rows[0] ? rowToTask(rows[0]) : null;
    },

    async list(filter: TaskFilter = {}): Promise<Task[]> {
      const { where, params } = filterSql(filter, false);
      const { rows } = await q(`SELECT * FROM tasks${where} ORDER BY created_at, id`, params);
      return rows.map(rowToTask);
    },

    async listOpen(filter: OpenTaskFilter = {}): Promise<Task[]> {
      const { where, params } = filterSql(filter, true);
      const { rows } = await q(`SELECT * FROM tasks${where} ORDER BY created_at, id`, params);
      return rows.map(rowToTask);
    },

    async transitionStatus(id, expectedStatus, nextStatus, runId): Promise<Task | null> {
      const at = now();
      const client = await (await pg.pool()).connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query(
          `UPDATE tasks SET status = $3, updated_at = $4
           WHERE id = $1 AND status = $2 RETURNING *`,
          [id, expectedStatus, nextStatus, at],
        );
        const row = updated.rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `INSERT INTO task_events(task_id, run_id, type, from_status, to_status, created_at)
           VALUES ($1,$2,'status_changed',$3,$4,$5)`,
          [id, runId, expectedStatus, nextStatus, at],
        );
        await client.query("COMMIT");
        return rowToTask(row);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listEvents(taskId): Promise<TaskEvent[]> {
      const { rows } = await q("SELECT * FROM task_events WHERE task_id = $1 ORDER BY id", [taskId]);
      return rows.map(rowToEvent);
    },

    async close(): Promise<void> {
      await pg.close();
    },
  };
}
