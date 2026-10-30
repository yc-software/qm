import { tableConversion, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { SandboxDefault, SandboxResource } from "./sandbox-resources.ts";
import { tenantMap } from "../tenants/context.ts";

const RESOURCES: TableSpec<SandboxResource, "id"> = {
  table: "sandbox_resources",
  fieldKey: "id",
  required: ["backend", "ownerScopeId", "backingScopeId", "name", "createdBy", "createdAt", "legacy", "state"],
  columns: {
    backend: "text",
    ownerScopeId: "text",
    backingScopeId: "text",
    name: "text",
    createdBy: "text",
    createdAt: "text",
    legacy: "boolean",
    state: "text",
    machineId: "text",
    cleanupPending: "boolean",
    holders: "text[]",
    spec: "jsonb",
    error: "text",
    jobOnly: "boolean",
  },
};

const DEFAULTS: TableSpec<SandboxDefault> = {
  table: "sandbox_defaults",
  key: "scopeId",
  columns: { sandboxId: "text" },
};

export const SANDBOX_RESOURCE_MIGRATIONS = [
  tableConversion(RESOURCES, {
    indexes: [
      "CREATE INDEX sandbox_resources_owner ON sandbox_resources (tenant_id, owner_scope_id) WHERE job_only IS NOT TRUE",
      "CREATE INDEX sandbox_resources_job_only ON sandbox_resources (tenant_id) WHERE job_only",
    ],
  }),
  tableConversion(DEFAULTS),
] as const;

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
  const records = typedTable(databaseUrl, RESOURCES, SANDBOX_RESOURCE_MIGRATIONS[0]);
  const defaults = typedTable(databaseUrl, DEFAULTS, SANDBOX_RESOURCE_MIGRATIONS[1]);
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

export function createMemorySandboxResourceStores(): { records: SandboxResourceRecords; defaults: SandboxDefaults } {
  const tenantRecords = tenantMap<SandboxResource>();
  const tenantDefaults = tenantMap<SandboxDefault>();
  const sorted = () =>
    [...tenantRecords().values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => structuredClone(r));
  return {
    records: {
      get: async (id) => structuredClone(tenantRecords().get(id) ?? null),
      async put(id, record) {
        tenantRecords().set(id, structuredClone(record));
      },
      async update(id, fn) {
        const current = tenantRecords().get(id);
        if (!current) return null;
        const next = fn(structuredClone(current));
        tenantRecords().set(id, structuredClone(next));
        return next;
      },
      async delete(id) {
        tenantRecords().delete(id);
      },
      owners: async () =>
        [
          ...new Set(
            sorted()
              .filter((r) => !r.jobOnly)
              .map((r) => r.ownerScopeId),
          ),
        ].sort(),
      ownedBy: async (scopes) => sorted().filter((r) => !r.jobOnly && scopes.includes(r.ownerScopeId)),
      jobComputers: async () => sorted().filter((r) => r.jobOnly),
    },
    defaults: {
      get: async (scopeId) => structuredClone(tenantDefaults().get(scopeId) ?? null),
      async put(scopeId, value) {
        tenantDefaults().set(scopeId, structuredClone(value));
      },
    },
  };
}
