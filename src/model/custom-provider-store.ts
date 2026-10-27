import { tenantSecretKey } from "../credentials/tenant-secret-key.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface CustomProviderStore {
  enabled(): Promise<CustomProviderSpec[]>;
  statuses(): Promise<CustomProviderStatus[]>;
  resolveKey(id: string): Promise<string | null>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

const CUSTOM_PROVIDERS: TableSpec = {
  table: "custom_model_providers",
  key: "id",
  keyIsField: true,
  columns: cols(`name text!, protocol text!, baseUrl text!, models jsonb!, apiKeyEnc text, disabled boolean,
    updatedAt bigint!, updatedBy text!`),
};

const CUSTOM_PROVIDERS_MIGRATION = mapToTableMigration("model/custom-providers/0001-typed", CUSTOM_PROVIDERS);

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models,
  };
}

export function createCustomProviderStore(input: {
  databaseUrl: string;
  keyMaterial: () => string | Buffer;
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
}): CustomProviderStore {
  const write = input.write ?? (<T>(fn: () => Promise<T>) => fn());
  const key = tenantSecretKey(() => deriveConnectorKey(input.keyMaterial(), "custom-model-providers"));
  const pg = createPgPool(input.databaseUrl, [CUSTOM_PROVIDERS_MIGRATION]);
  const table = typedTable<StoredCustomProvider>(pg, CUSTOM_PROVIDERS);

  return {
    async enabled() {
      const rows = await pg.q(
        `SELECT ${table.codec.columns} FROM custom_model_providers WHERE disabled IS NOT TRUE ORDER BY id`,
      );
      return table.codec.rows(rows).map(strip);
    },

    async statuses() {
      return (await table.all()).map((p) => ({
        ...strip(p),
        disabled: p.disabled ?? false,
        hasKey: Boolean(p.apiKeyEnc),
        updatedAt: p.updatedAt,
        updatedBy: p.updatedBy,
      }));
    },

    async resolveKey(id) {
      const saved = await table.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async upsert(spec, apiKey, updatedBy) {
      return write(async () => {
        validateCustomProviderSpec(spec);
        const actor = updatedBy.trim();
        if (!actor) throw new Error("updatedBy is required");
        const existing = await table.get(spec.id);
        const trimmedKey = apiKey?.trim();
        const apiKeyEnc = trimmedKey ? encryptSecret(trimmedKey, key) : existing?.apiKeyEnc;
        await table.put(spec.id, {
          ...spec,
          ...(apiKeyEnc ? { apiKeyEnc } : {}),
          disabled: false,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id, updatedBy) {
      return write(async () => {
        const rows = await pg.q(
          `UPDATE custom_model_providers SET disabled = true, updated_at = $2, updated_by = $3
           WHERE id = $1 AND disabled IS NOT TRUE RETURNING id`,
          [id, Date.now(), updatedBy],
        );
        return rows.length > 0;
      });
    },
  };
}
