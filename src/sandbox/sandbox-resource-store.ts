import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { jsonBackfill } from "../persistence/typed-statements.ts";
import { pgRows, type RowColumns, type RowTable } from "../persistence/keyed-rows.ts";
import type { SandboxDefault, SandboxResource } from "./sandbox-resources.ts";

const RESOURCES_COLUMNS: RowColumns<SandboxResource, "id"> = {
  id: "text",
  backend: "text",
  ownerScopeId: "text",
  backingScopeId: "text",
  name: "text",
  createdBy: "text",
  createdAt: "text",
  legacy: "boolean",
  state: "text",
  machineId: "text",
  providerName: "text",
  cleanupPending: "boolean",
  holders: "text[]",
  spec: "jsonb",
  error: "text",
  jobOnly: "boolean",
};

const RESOURCES: RowTable<SandboxResource, "id"> = {
  table: "sandbox_resources",
  key: "id",
  recordKey: true,
  columns: RESOURCES_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "sandbox_resources",
      columns: [
        "id TEXT NOT NULL",
        "backend TEXT NOT NULL",
        "owner_scope_id TEXT NOT NULL",
        "backing_scope_id TEXT NOT NULL",
        "name TEXT NOT NULL",
        "created_by TEXT NOT NULL",
        "created_at TEXT NOT NULL",
        "legacy BOOLEAN NOT NULL",
        "state TEXT NOT NULL",
        "machine_id TEXT",
        "provider_name TEXT",
        "cleanup_pending BOOLEAN",
        "holders TEXT[]",
        "spec JSONB",
        "error TEXT",
        "job_only BOOLEAN",
      ],
      primaryKey: ["id"],
      backfill: { ...jsonBackfill("sandbox_resources", RESOURCES_COLUMNS) },
      indexes: [
        "CREATE INDEX sandbox_resources_owner ON sandbox_resources (tenant_id, owner_scope_id) WHERE job_only IS NOT TRUE",
        "CREATE INDEX sandbox_resources_job_only ON sandbox_resources (tenant_id) WHERE job_only",
      ],
    }),
  ],
};

const DEFAULTS_COLUMNS: RowColumns<SandboxDefault, "scopeId"> = {
  scopeId: "text",
  sandboxId: "text",
};

const DEFAULTS: RowTable<SandboxDefault, "scopeId"> = {
  table: "sandbox_defaults",
  key: "scopeId",
  columns: DEFAULTS_COLUMNS,
  migrations: [
    typedTableMigration({
      table: "sandbox_defaults",
      columns: ["scope_id TEXT NOT NULL", "sandbox_id TEXT"],
      primaryKey: ["scope_id"],
      backfill: { ...jsonBackfill("sandbox_defaults", DEFAULTS_COLUMNS), scope_id: "id" },
    }),
  ],
};

const dropTables = (id: string, tables: readonly string[]) => ({
  id,
  statements: [
    `DROP TABLE IF EXISTS ${tables.join(", ")}`,
    `DO $versions$ BEGIN
       IF to_regclass('durable_map_versions') IS NOT NULL THEN
         DELETE FROM durable_map_versions WHERE tbl IN (${tables.map((t) => `'${t}'`).join(", ")});
       END IF;
     END $versions$`,
  ],
});

const RETIRED_TABLES = [
  dropTables("tenancy/sandbox_routing/0001-drop", ["sandbox_routing", "sandbox_resource_rollout"]),
  dropTables("tenancy/retired-sandbox-backends/0001", [
    "aws_sandbox_bodies",
    "superserve_sandbox_bodies",
    "superserve_config_epochs",
  ]),
];

export interface SandboxResourceRecords {
  get(id: string): Promise<SandboxResource | null>;
  put(id: string, record: SandboxResource): Promise<void>;
  update(id: string, fn: (current: SandboxResource) => SandboxResource): Promise<SandboxResource | null>;
  delete(id: string): Promise<void>;
  owners(): Promise<string[]>;
  ownedBy(scopes: readonly string[]): Promise<SandboxResource[]>;
  jobComputers(): Promise<SandboxResource[]>;
}

export interface SandboxDefaults {
  get(scopeId: string): Promise<SandboxDefault | null>;
  put(scopeId: string, value: SandboxDefault): Promise<void>;
}

export function createSandboxResourceStores(databaseUrl: string): {
  records: SandboxResourceRecords;
  defaults: SandboxDefaults;
  close(): Promise<void>;
} {
  const records = pgRows(databaseUrl, RESOURCES);
  const defaults = pgRows(databaseUrl, { ...DEFAULTS, migrations: [...DEFAULTS.migrations, ...RETIRED_TABLES] });
  const visible = "job_only IS NOT TRUE";
  return {
    records: {
      get: records.get,
      put: records.put,
      update: records.update,
      delete: records.delete,
      owners: async () =>
        (
          await records.db.q(
            `SELECT DISTINCT owner_scope_id FROM sandbox_resources WHERE ${records.scoped(visible)} ORDER BY 1`,
          )
        ).map((r) => String(r.owner_scope_id)),
      ownedBy: async (scopes) =>
        (
          await records.db.q(
            `${records.select} WHERE ${records.scoped(`${visible} AND owner_scope_id = ANY($1)`)} ORDER BY id`,
            [[...scopes]],
          )
        ).map(records.row),
      jobComputers: async () =>
        (await records.db.q(`${records.select} WHERE ${records.scoped("job_only")} ORDER BY id`)).map(records.row),
    },
    defaults: { get: defaults.get, put: defaults.put },
    close: async () => {
      await Promise.all([records.db.close(), defaults.db.close()]);
    },
  };
}
