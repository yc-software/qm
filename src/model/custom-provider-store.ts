/**
 * Durable, encrypted storage for custom model providers.
 *
 * Mirrors model-credential-store: specs live in a DurableMap, API keys
 * are encrypted at rest with a key derived from the connector secret,
 * and the store never hands the plaintext key to anything but the
 * per-call resolver.
 */

import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

export interface StoredCustomProvider extends CustomProviderSpec {
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
  /** Enabled specs only — what the runtime registry should serve. */
  enabled(): Promise<CustomProviderSpec[]>;
  /** Everything, for the admin surface (no secrets). */
  statuses(): Promise<CustomProviderStatus[]>;
  /** Plaintext key for one provider, or null when absent/disabled. */
  resolveKey(id: string): Promise<string | null>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

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
  backing: DurableMap<StoredCustomProvider>;
  keyMaterial: string | Buffer;
}): CustomProviderStore {
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");

  return {
    async enabled() {
      const all = await input.backing.all();
      return all.filter((p) => !p.disabled).map(strip);
    },

    async statuses() {
      const all = await input.backing.all();
      return all
        .map((p) => ({
          ...strip(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async upsert(spec, apiKey, updatedBy) {
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
    },

    async delete(id, updatedBy) {
      const existing = await input.backing.get(id);
      if (!existing || existing.disabled) return false;
      await input.backing.put(id, {
        ...existing,
        disabled: true,
        updatedAt: Date.now(),
        updatedBy,
      });
      return true;
    },
  };
}
