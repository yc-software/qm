import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { MODEL_PROVIDERS, type ModelProvider, type ModelProviderAvailability } from "./pi-models.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

export { isModelProvider, type ModelProvider } from "./pi-models.ts";

export interface StoredModelCredential {
  provider: ModelProvider;
  secretEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface ModelCredentialStatus {
  provider: ModelProvider;
  configured: boolean;
  source: "admin" | "environment" | "absent";
  updatedAt?: number;
  updatedBy?: string;
}

export interface ModelCredentialStore {
  resolve(provider: ModelProvider): Promise<string | null>;
  set(provider: ModelProvider, apiKey: string, updatedBy: string): Promise<void>;
  delete(provider: ModelProvider, updatedBy: string): Promise<void>;
  statuses(): Promise<ModelCredentialStatus[]>;
  availability(): Promise<ModelProviderAvailability>;
}

export function createModelCredentialStore(input: {
  backing: DurableMap<StoredModelCredential>;
  keyMaterial: string | Buffer;
  fallback?: Partial<Record<ModelProvider, string>>;
}): ModelCredentialStore {
  const key = deriveConnectorKey(input.keyMaterial, "model-credentials");

  async function record(provider: ModelProvider): Promise<StoredModelCredential | null> {
    return input.backing.get(provider);
  }

  return {
    async resolve(provider) {
      const saved = await record(provider);
      if (saved?.disabled) return null;
      return saved?.secretEnc ? decryptSecret(saved.secretEnc, key) : input.fallback?.[provider]?.trim() || null;
    },

    async set(provider, apiKey, updatedBy) {
      const secret = apiKey.trim();
      if (!secret) throw new Error("API key is required");
      const actor = updatedBy.trim();
      if (!actor) throw new Error("updatedBy is required");
      await input.backing.put(provider, {
        provider,
        secretEnc: encryptSecret(secret, key),
        disabled: false,
        updatedAt: Date.now(),
        updatedBy: actor,
      });
    },

    async delete(provider, updatedBy) {
      await input.backing.put(provider, {
        provider,
        disabled: true,
        updatedAt: Date.now(),
        updatedBy,
      });
    },

    async statuses() {
      return Promise.all(
        MODEL_PROVIDERS.map(async (provider): Promise<ModelCredentialStatus> => {
          const saved = await record(provider);
          if (saved)
            return {
              provider,
              configured: !saved.disabled,
              source: "admin",
              updatedAt: saved.updatedAt,
              updatedBy: saved.updatedBy,
            };
          return input.fallback?.[provider]?.trim()
            ? { provider, configured: true, source: "environment" }
            : { provider, configured: false, source: "absent" };
        }),
      );
    },

    async availability() {
      const configured = new Map((await this.statuses()).map((status) => [status.provider, status.configured]));
      return {
        anthropic: configured.get("anthropic") === true,
        openai: configured.get("openai") === true,
        openrouter: configured.get("openrouter") === true,
      };
    },
  };
}

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

function customProviderSpec(saved: StoredCustomProvider): CustomProviderSpec {
  return { id: saved.id, name: saved.name, protocol: saved.protocol, baseUrl: saved.baseUrl, models: saved.models };
}

export function createCustomProviderStore(input: {
  backing: DurableMap<StoredCustomProvider>;
  keyMaterial: string | Buffer;
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const write = input.write ?? (<T>(fn: () => Promise<T>) => fn());
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");

  return {
    async enabled(): Promise<CustomProviderSpec[]> {
      return (await input.backing.all()).filter((p) => !p.disabled).map(customProviderSpec);
    },

    async statuses() {
      return (await input.backing.all())
        .map((p) => ({
          ...customProviderSpec(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id: string): Promise<string | null> {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void> {
      return write(async () => {
        validateCustomProviderSpec(spec);
        const actor = updatedBy.trim();
        if (!actor) throw new Error("updatedBy is required");
        const existing = await input.backing.get(spec.id);
        const trimmedKey = apiKey?.trim();
        const apiKeyEnc = trimmedKey ? encryptSecret(trimmedKey, key) : existing?.apiKeyEnc;
        await input.backing.put(spec.id, {
          ...spec,
          ...(apiKeyEnc ? { apiKeyEnc } : {}),
          disabled: false,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id: string, updatedBy: string): Promise<boolean> {
      return write(async () => {
        const existing = await input.backing.get(id);
        if (!existing || existing.disabled) return false;
        await input.backing.put(id, { ...existing, disabled: true, updatedAt: Date.now(), updatedBy });
        return true;
      });
    },
  };
}

export type CustomProviderStore = ReturnType<typeof createCustomProviderStore>;
