import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { MODEL_PROVIDERS, type ModelProvider, type ModelProviderAvailability } from "./pi-models.ts";

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
          if (saved && !saved.disabled) {
            return {
              provider,
              configured: true,
              source: "admin",
              updatedAt: saved.updatedAt,
              updatedBy: saved.updatedBy,
            };
          }
          if (saved?.disabled)
            return {
              provider,
              configured: false,
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
      const statuses = await this.statuses();
      return {
        anthropic: statuses.find((status) => status.provider === "anthropic")!.configured,
        openai: statuses.find((status) => status.provider === "openai")!.configured,
        openrouter: statuses.find((status) => status.provider === "openrouter")!.configured,
      };
    },
  };
}
