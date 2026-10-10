import type { ProcessCredentialFiles } from "../credentials/execute-files.ts";
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
  sandboxId?: string;
  kind: ProcessKind;
  command: string;
  purpose?: string;
  startedAt: number;
  expiresAt: number;
  status: ProcessStatus;
  sessionRef?: string;
  runId?: string;
  credentialsPending?: boolean;
}

interface NewProcessRecord {
  processId: string;
  scopeId: string;
  sandboxId?: string;
  kind: ProcessKind;
  command: string;
  purpose?: string;
  ttlMs: number;
  sessionRef?: string;
  runId?: string;
  credentialFiles?: ProcessCredentialFiles;
}

export interface ProcessRegistry {
  register(rec: NewProcessRecord): Promise<ProcessRecord>;
  get(processId: string): Promise<ProcessRecord | null>;
  listByScope(scopeId: string): Promise<ProcessRecord[]>;
  liveByScope(scopeId: string, now?: number): Promise<ProcessRecord[]>;
  listLive(now?: number): Promise<ProcessRecord[]>;
  markStatus(processId: string, status: ProcessStatus): Promise<boolean>;
  credentialFiles(processId: string): Promise<ProcessCredentialFiles | null>;
  setCredentialFiles(processId: string, files: ProcessCredentialFiles | null): Promise<void>;
  listExpired(now?: number): Promise<ProcessRecord[]>;
  delete(processId: string): Promise<void>;
  close?(): void;
}

function newRecord(rec: NewProcessRecord, now: number): ProcessRecord {
  if (!isDeclaredKind(rec.kind)) throw new Error(`process kind not declared: ${rec.kind}`);
  return {
    processId: rec.processId,
    scopeId: rec.scopeId,
    ...(rec.sandboxId ? { sandboxId: rec.sandboxId } : {}),
    kind: rec.kind,
    command: rec.command,
    ...(rec.purpose ? { purpose: rec.purpose } : {}),
    startedAt: now,
    expiresAt: now + rec.ttlMs,
    status: "running",
    ...(rec.sessionRef ? { sessionRef: rec.sessionRef } : {}),
    ...(rec.runId ? { runId: rec.runId } : {}),
  };
}

export function createMemoryProcessRegistry(): ProcessRegistry {
  const rows = new Map<string, ProcessRecord>();
  const credentialFiles = new Map<string, ProcessCredentialFiles>();
  const view = (row: ProcessRecord): ProcessRecord => ({
    ...row,
    ...(credentialFiles.has(row.processId) ? { credentialsPending: true } : {}),
  });
  return {
    async register(rec) {
      const row = newRecord(rec, Date.now());
      rows.set(row.processId, row);
      if (rec.credentialFiles) credentialFiles.set(row.processId, rec.credentialFiles);
      return { ...row };
    },
    async credentialFiles(processId) {
      return credentialFiles.get(processId) ?? null;
    },
    async setCredentialFiles(processId, files) {
      if (!files) credentialFiles.delete(processId);
      else if (rows.has(processId)) credentialFiles.set(processId, files);
    },
    async get(processId) {
      const row = rows.get(processId);
      return row ? view(row) : null;
    },
    async listByScope(scopeId) {
      return [...rows.values()].filter((r) => r.scopeId === scopeId).map(view);
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
      if (row?.status !== "running") return false;
      row.status = status;
      return true;
    },
    async listExpired(now = Date.now()) {
      return [...rows.values()].filter((r) => r.status === "running" && r.expiresAt <= now).map((r) => ({ ...r }));
    },
    async delete(processId) {
      rows.delete(processId);
      credentialFiles.delete(processId);
    },
  };
}

function pgRowToRecord(r: Record<string, unknown>): ProcessRecord {
  return {
    processId: r.process_id as string,
    scopeId: r.scope_id as string,
    ...(r.sandbox_id ? { sandboxId: r.sandbox_id as string } : {}),
    kind: r.kind as ProcessKind,
    command: r.command as string,
    ...(r.purpose ? { purpose: r.purpose as string } : {}),
    startedAt: Number(r.started_at),
    expiresAt: Number(r.expires_at),
    status: r.status as ProcessStatus,
    ...(r.session_ref ? { sessionRef: r.session_ref as string } : {}),
    ...(r.run_id ? { runId: r.run_id as string } : {}),
    ...(r.credential_files != null ? { credentialsPending: true } : {}),
  };
}

export function createPostgresProcessRegistry(connectionString: string): ProcessRegistry {
  const pg = createPgPool(connectionString, "processes/registry/0001", [
    `CREATE TABLE IF NOT EXISTS process_sessions(
        process_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
        command TEXT NOT NULL, started_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
        status TEXT NOT NULL
      )`,
    `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS session_ref TEXT`,
    `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS run_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_proc_scope_status ON process_sessions(scope_id, status)`,
  ]);

  const migration = {
    id: "processes/registry/0002",
    statements: ["ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS sandbox_id TEXT"],
  };
  pg.registerMigration(migration);
  const purposeMigration = {
    id: "processes/registry/0003",
    statements: ["ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS purpose TEXT"],
  };
  pg.registerMigration(purposeMigration);
  const credentialFilesMigration = {
    id: "processes/registry/0004",
    statements: ["ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS credential_files JSONB"],
  };
  pg.registerMigration(credentialFilesMigration);
  let ready: Promise<void> | undefined;
  const q: typeof pg.q = async (...args) => {
    ready ??= pg
      .migrate(migration)
      .then(() => pg.migrate(purposeMigration))
      .then(() => pg.migrate(credentialFilesMigration))
      .catch((error) => {
        ready = undefined;
        throw error;
      });
    await ready;
    return pg.q(...args);
  };
  return {
    async register(rec) {
      const row = newRecord(rec, Date.now());
      await q(
        `INSERT INTO process_sessions(process_id, scope_id, kind, command, started_at, expires_at, status, session_ref, run_id, sandbox_id, purpose, credential_files)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
          row.sandboxId ?? null,
          row.purpose ?? null,
          rec.credentialFiles ? JSON.stringify(rec.credentialFiles) : null,
        ],
      );
      return row;
    },
    async credentialFiles(processId) {
      const rows = await q("SELECT credential_files FROM process_sessions WHERE process_id = $1", [processId]);
      return (rows[0]?.credential_files as ProcessCredentialFiles | null | undefined) ?? null;
    },
    async setCredentialFiles(processId, files) {
      await q("UPDATE process_sessions SET credential_files = $2 WHERE process_id = $1", [
        processId,
        files ? JSON.stringify(files) : null,
      ]);
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
      const updated = await q(
        "UPDATE process_sessions SET status = $1 WHERE process_id = $2 AND status = 'running' RETURNING process_id",
        [status, processId],
      );
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
