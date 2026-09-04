import { createPgPool } from "../persistence/pg-pool.ts";

export type ProcessKind = "build" | "dev-server" | "background";

const DECLARED_KINDS: ReadonlySet<ProcessKind> = new Set<ProcessKind>(["build", "dev-server", "background"]);

export function isDeclaredKind(kind: string): kind is ProcessKind {
  return DECLARED_KINDS.has(kind as ProcessKind);
}

export type ProcessStatus = "running" | "exited" | "reaped";

export interface ProcessRecord {
  processId: string;
  scopeId: string;
  kind: ProcessKind;
  command: string;
  startedAt: number;
  expiresAt: number;
  status: ProcessStatus;
  sessionRef?: string;
  runId?: string;
}

interface NewProcessRecord {
  processId: string;
  scopeId: string;
  kind: ProcessKind;
  command: string;
  ttlMs: number;
  sessionRef?: string;
  runId?: string;
}

export interface ProcessRegistry {
  register(rec: NewProcessRecord): Promise<ProcessRecord>;
  get(processId: string): Promise<ProcessRecord | null>;
  listByScope(scopeId: string): Promise<ProcessRecord[]>;
  liveByScope(scopeId: string, now?: number): Promise<ProcessRecord[]>;
  listLive(now?: number): Promise<ProcessRecord[]>;
  markStatus(processId: string, status: ProcessStatus): Promise<boolean>;
  listExpired(now?: number): Promise<ProcessRecord[]>;
  delete(processId: string): Promise<void>;
  close?(): void;
}

function newRecord(rec: NewProcessRecord, now: number): ProcessRecord {
  if (!isDeclaredKind(rec.kind)) throw new Error(`process kind not declared: ${rec.kind}`);
  return {
    processId: rec.processId,
    scopeId: rec.scopeId,
    kind: rec.kind,
    command: rec.command,
    startedAt: now,
    expiresAt: now + rec.ttlMs,
    status: "running",
    ...(rec.sessionRef ? { sessionRef: rec.sessionRef } : {}),
    ...(rec.runId ? { runId: rec.runId } : {}),
  };
}

export function createMemoryProcessRegistry(): ProcessRegistry {
  const rows = new Map<string, ProcessRecord>();
  return {
    async register(rec) {
      const row = newRecord(rec, Date.now());
      rows.set(row.processId, row);
      return { ...row };
    },
    async get(processId) {
      const row = rows.get(processId);
      return row ? { ...row } : null;
    },
    async listByScope(scopeId) {
      return [...rows.values()].filter((r) => r.scopeId === scopeId).map((r) => ({ ...r }));
    },
    async liveByScope(scopeId, now = Date.now()) {
      return [...rows.values()]
        .filter((r) => r.scopeId === scopeId && r.status === "running" && r.expiresAt > now)
        .map((r) => ({ ...r }));
    },
    async listLive(now = Date.now()) {
      return [...rows.values()].filter((r) => r.status === "running" && r.expiresAt > now).map((r) => ({ ...r }));
    },
    async markStatus(processId, status) {
      const row = rows.get(processId);
      if (!row) return false;
      row.status = status;
      return true;
    },
    async listExpired(now = Date.now()) {
      return [...rows.values()].filter((r) => r.status === "running" && r.expiresAt <= now).map((r) => ({ ...r }));
    },
    async delete(processId) {
      rows.delete(processId);
    },
  };
}

function pgRowToRecord(r: Record<string, unknown>): ProcessRecord {
  return {
    processId: r.process_id as string,
    scopeId: r.scope_id as string,
    kind: r.kind as ProcessKind,
    command: r.command as string,
    startedAt: Number(r.started_at),
    expiresAt: Number(r.expires_at),
    status: r.status as ProcessStatus,
    ...(r.session_ref ? { sessionRef: r.session_ref as string } : {}),
    ...(r.run_id ? { runId: r.run_id as string } : {}),
  };
}

export function createPostgresProcessRegistry(connectionString: string): ProcessRegistry {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS process_sessions(
        process_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
        command TEXT NOT NULL, started_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
        status TEXT NOT NULL
      )`,
    `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS session_ref TEXT`,
    `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS run_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_proc_scope_status ON process_sessions(scope_id, status)`,
  ]);

  return {
    async register(rec) {
      const row = newRecord(rec, Date.now());
      await q(
        `INSERT INTO process_sessions(process_id, scope_id, kind, command, started_at, expires_at, status, session_ref, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.processId,
          row.scopeId,
          row.kind,
          row.command,
          row.startedAt,
          row.expiresAt,
          row.status,
          row.sessionRef ?? null,
          row.runId ?? null,
        ],
      );
      return row;
    },
    async get(processId) {
      const rows = await q("SELECT * FROM process_sessions WHERE process_id = $1", [processId]);
      return rows.length ? pgRowToRecord(rows[0]!) : null;
    },
    async listByScope(scopeId) {
      return (await q("SELECT * FROM process_sessions WHERE scope_id = $1", [scopeId])).map(pgRowToRecord);
    },
    async liveByScope(scopeId, now = Date.now()) {
      const rows = await q(
        "SELECT * FROM process_sessions WHERE scope_id = $1 AND status = 'running' AND expires_at > $2",
        [scopeId, now],
      );
      return rows.map(pgRowToRecord);
    },
    async listLive(now = Date.now()) {
      const rows = await q("SELECT * FROM process_sessions WHERE status = 'running' AND expires_at > $1", [now]);
      return rows.map(pgRowToRecord);
    },
    async markStatus(processId, status) {
      const updated = await q("UPDATE process_sessions SET status = $1 WHERE process_id = $2 RETURNING process_id", [
        status,
        processId,
      ]);
      return updated.length > 0;
    },
    async listExpired(now = Date.now()) {
      const rows = await q("SELECT * FROM process_sessions WHERE status = 'running' AND expires_at <= $1", [now]);
      return rows.map(pgRowToRecord);
    },
    async delete(processId) {
      await q("DELETE FROM process_sessions WHERE process_id = $1", [processId]);
    },
  };
}
