import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";

export interface SecretStore {
  put(name: string, value: string): Promise<string>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export type SecretStoreFactory = (key: SecretKey) => SecretStore;

export const VAULT_REF = "vault:";

export function createEncryptedSecretStore(key: SecretKey): SecretStore {
  return {
    async put(_name, value) {
      return encryptSecret(value, key);
    },
    async get(ref) {
      if (ref.startsWith(VAULT_REF)) throw new Error(`secret ${ref} is stored in Vault, but VAULT_ADDR is not set`);
      return decryptSecret(ref, key);
    },
    async delete() {},
  };
}

export async function deleteReplacedSecrets(
  store: SecretStore,
  previous: readonly (string | undefined)[],
  next: readonly (string | undefined)[],
): Promise<void> {
  for (const ref of previous) if (ref && !next.includes(ref)) await store.delete(ref);
}
