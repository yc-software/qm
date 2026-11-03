import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { typedColumns, type ColumnCast } from "../persistence/typed-columns.ts";
import { jsonBackfill, upsertStatement } from "../persistence/typed-statements.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { StoredCustomProvider } from "./model-credential-store.ts";
import type { ModelProvider, StoredModelCredential } from "./model-credential-store.ts";
import type { StoredModelOverlay } from "./model-overlay-store.ts";

export interface ModelCredentialRows {
  get(provider: ModelProvider): Promise<StoredModelCredential | null>;
  put(rec: StoredModelCredential): Promise<void>;
}

export interface CustomProviderRows {
  get(id: string): Promise<StoredCustomProvider | null>;
  put(rec: StoredCustomProvider): Promise<void>;
  all(): Promise<StoredCustomProvider[]>;
  enabled(): Promise<StoredCustomProvider[]>;
}

export interface ModelRegistryRows {
  get(id: string): Promise<StoredModelOverlay | null>;
  put(id: string, row: StoredModelOverlay): Promise<void>;
  all(): Promise<Array<{ id: string; row: StoredModelOverlay }>>;
}

export interface ModelTables {
  credentials: ModelCredentialRows;
  customProviders: CustomProviderRows;
  registry: ModelRegistryRows;
}

type RegistryRow = StoredModelOverlay & { id: string };

const CREDENTIAL_SPEC: { readonly [K in keyof StoredModelCredential]-?: ColumnCast } = {
  provider: "text",
  secretEnc: "text",
  disabled: "boolean",
  updatedAt: "bigint",
  updatedBy: "text",
};

const PROVIDER_SPEC: { readonly [K in keyof StoredCustomProvider]-?: ColumnCast } = {
  id: "text",
  name: "text",
  protocol: "text",
  baseUrl: "text",
  models: "jsonb",
  apiKeyEnc: "text",
  disabled: "boolean",
  updatedAt: "bigint",
  updatedBy: "text",
};

const REGISTRY_SPEC: { readonly [K in keyof RegistryRow]-?: ColumnCast } = {
  id: "text",
  spec: "jsonb",
  disabled: "boolean",
  updatedAt: "bigint",
  updatedBy: "text",
  verification: "jsonb",
};

const CREDENTIAL = typedColumns<StoredModelCredential>(CREDENTIAL_SPEC);
const PROVIDER = typedColumns<StoredCustomProvider>(PROVIDER_SPEC);
const REGISTRY = typedColumns<RegistryRow>(REGISTRY_SPEC);

const updated = {
  disabled: "COALESCE((json->>'disabled')::boolean, false)",
  updated_at: "COALESCE((json->>'updatedAt')::numeric::bigint, 0)",
  updated_by: "COALESCE(json->>'updatedBy', '')",
};

const MODEL_TABLE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  typedTableMigration({
    table: "model_credentials",
    columns: [
      "provider TEXT NOT NULL",
      "secret_enc TEXT",
      "disabled BOOLEAN NOT NULL",
      "updated_at BIGINT NOT NULL",
      "updated_by TEXT NOT NULL",
    ],
    primaryKey: ["provider"],
    backfill: { ...jsonBackfill("model_credentials", CREDENTIAL_SPEC), provider: "id", ...updated },
  }),
  typedTableMigration({
    table: "custom_model_providers",
    columns: [
      "id TEXT NOT NULL",
      "name TEXT NOT NULL",
      "protocol TEXT NOT NULL",
      "base_url TEXT NOT NULL",
      "models JSONB NOT NULL",
      "api_key_enc TEXT",
      "disabled BOOLEAN NOT NULL",
      "updated_at BIGINT NOT NULL",
      "updated_by TEXT NOT NULL",
    ],
    primaryKey: ["id"],
    backfill: {
      ...jsonBackfill("custom_model_providers", PROVIDER_SPEC),
      name: "COALESCE(json->>'name', id)",
      models: "COALESCE(NULLIF(json->'models', 'null'::jsonb), '[]'::jsonb)",
      ...updated,
    },
    where: "json->>'protocol' IS NOT NULL AND json->>'baseUrl' IS NOT NULL",
  }),
  typedTableMigration({
    table: "model_registry",
    columns: [
      "id TEXT NOT NULL",
      "spec JSONB NOT NULL",
      "disabled BOOLEAN NOT NULL",
      "updated_at BIGINT NOT NULL",
      "updated_by TEXT NOT NULL",
      "verification JSONB",
    ],
    primaryKey: ["id"],
    backfill: { ...jsonBackfill("model_registry", REGISTRY_SPEC), ...updated },
    where: "jsonb_typeof(json->'spec') = 'object'",
  }),
];

export function createPostgresModelTables(connectionString: string): ModelTables & { close(): Promise<void> } {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, ...MODEL_TABLE_MIGRATIONS]);
  const MINE = `tenant_id = ${TENANT}`;
  const providers = async (where: string) =>
    (await q(`SELECT ${PROVIDER.names} FROM custom_model_providers WHERE ${MINE}${where} ORDER BY id`)).map((row) =>
      PROVIDER.fromRow(row),
    );
  return {
    close,
    credentials: {
      async get(provider) {
        const [row] = await q(`SELECT ${CREDENTIAL.names} FROM model_credentials WHERE ${MINE} AND provider = $1`, [
          provider,
        ]);
        return row ? CREDENTIAL.fromRow(row) : null;
      },
      async put(rec) {
        await q(
          upsertStatement("model_credentials", CREDENTIAL, "provider"),
          CREDENTIAL.params({ ...rec, disabled: rec.disabled === true }),
        );
      },
    },
    customProviders: {
      async get(id) {
        const [row] = await q(`SELECT ${PROVIDER.names} FROM custom_model_providers WHERE ${MINE} AND id = $1`, [id]);
        return row ? PROVIDER.fromRow(row) : null;
      },
      async put(rec) {
        await q(
          upsertStatement("custom_model_providers", PROVIDER, "id"),
          PROVIDER.params({ ...rec, disabled: rec.disabled === true }),
        );
      },
      all: () => providers(""),
      enabled: () => providers(" AND NOT disabled"),
    },
    registry: {
      async get(id) {
        const [row] = await q(`SELECT ${REGISTRY.names} FROM model_registry WHERE ${MINE} AND id = $1`, [id]);
        if (!row) return null;
        const { id: _id, ...stored } = REGISTRY.fromRow(row);
        return stored;
      },
      async put(id, row) {
        await q(upsertStatement("model_registry", REGISTRY, "id"), REGISTRY.params({ ...row, id }));
      },
      async all() {
        const rows = await q(`SELECT ${REGISTRY.names} FROM model_registry WHERE ${MINE} ORDER BY id`);
        return rows.map((found) => {
          const { id, ...row } = REGISTRY.fromRow(found);
          return { id, row };
        });
      },
    },
  };
}
