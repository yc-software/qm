import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { jsonBackfill } from "../persistence/typed-statements.ts";
import type { RowColumns, RowTable } from "../persistence/keyed-rows.ts";
import type { StoredRenderCleanup, StoredRenderSandbox, StoredRenderScratch } from "./render-sandbox.ts";

const RENDER_SANDBOX_BODIES_COLUMNS: RowColumns<StoredRenderSandbox, "scopeId"> = {
  scopeId: "text",
  sandboxId: "text",
  checkpoint: "jsonb",
  expiresAtMs: "bigint",
  lastActivityMs: "bigint",
  baseImage: "text",
  stopped: "boolean",
  homeDirty: "boolean",
  savedAtMs: "bigint",
  retiredResources: "jsonb",
  retirementError: "text",
  recoveryError: "text",
};

export const RENDER_SANDBOX_BODIES: RowTable<StoredRenderSandbox, "scopeId"> = {
  table: "render_sandbox_bodies",
  key: "scopeId",
  columns: RENDER_SANDBOX_BODIES_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "render_sandbox_bodies",
      columns: [
        "scope_id TEXT NOT NULL",
        "sandbox_id TEXT NOT NULL",
        "checkpoint JSONB",
        "expires_at_ms BIGINT NOT NULL",
        "last_activity_ms BIGINT NOT NULL",
        "base_image TEXT NOT NULL",
        "stopped BOOLEAN",
        "home_dirty BOOLEAN",
        "saved_at_ms BIGINT",
        "retired_resources JSONB",
        "retirement_error TEXT",
        "recovery_error TEXT",
      ],
      primaryKey: ["scope_id"],
      backfill: {
        ...jsonBackfill("render_sandbox_bodies", RENDER_SANDBOX_BODIES_COLUMNS),
        scope_id: "id",
        base_image: "COALESCE(json->>'baseImage', '')",
      },
    }),
  ],
};

const RENDER_SCRATCH_BODIES_COLUMNS: RowColumns<StoredRenderScratch, "name"> = {
  name: "text",
  id: "text",
  status: "text",
  expiresAtMs: "bigint",
  cleanupPending: "boolean",
};

export const RENDER_SCRATCH_BODIES: RowTable<StoredRenderScratch, "name"> = {
  table: "render_scratch_bodies",
  key: "name",
  columns: RENDER_SCRATCH_BODIES_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "render_scratch_bodies",
      columns: [
        "name TEXT NOT NULL",
        "id TEXT NOT NULL",
        "status TEXT NOT NULL",
        "expires_at_ms BIGINT NOT NULL",
        "cleanup_pending BOOLEAN",
      ],
      primaryKey: ["name"],
      backfill: {
        ...jsonBackfill("render_scratch_bodies", RENDER_SCRATCH_BODIES_COLUMNS),
        name: "id",
        id: "CASE WHEN jsonb_typeof(json->'id') = 'string' THEN json->>'id' END",
      },
    }),
  ],
};

const RENDER_SANDBOX_CLEANUP_COLUMNS: RowColumns<StoredRenderCleanup, "scopeId"> = {
  scopeId: "text",
  resources: "jsonb",
  error: "text",
};

export const RENDER_SANDBOX_CLEANUP: RowTable<StoredRenderCleanup, "scopeId"> = {
  table: "render_sandbox_cleanup",
  key: "scopeId",
  columns: RENDER_SANDBOX_CLEANUP_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "render_sandbox_cleanup",
      columns: ["scope_id TEXT NOT NULL", "resources JSONB NOT NULL", "error TEXT"],
      primaryKey: ["scope_id"],
      backfill: { ...jsonBackfill("render_sandbox_cleanup", RENDER_SANDBOX_CLEANUP_COLUMNS), scope_id: "id" },
    }),
  ],
};
