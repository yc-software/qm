import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const SESSION_LEASE_OWNERSHIP_MIGRATION: PgMigrationDefinition = {
  id: "runs/session-lease-owner/0001",
  statements: [
    `CREATE TABLE IF NOT EXISTS session_leases(session_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at BIGINT NOT NULL,holder TEXT,acquired_at BIGINT)`,
    `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS run_id TEXT`,
    `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS run_lease_token TEXT`,
  ],
};
