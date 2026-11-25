import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { errMessage } from "../util/errors.ts";

export interface SecretStore {
  put(name: string, value: string): Promise<string>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export type SecretStoreFactory = (key: SecretKey) => SecretStore;

export function createEncryptedSecretStore(key: SecretKey): SecretStore {
  return {
    async put(_name, value) {
      return encryptSecret(value, key);
    },
    async get(ref) {
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
  const dropped = [...new Set(previous.filter((ref): ref is string => !!ref && !next.includes(ref)))];
  await Promise.all(
    dropped.map(async (ref) => {
      try {
        await store.delete(ref);
      } catch (err) {
        console.error(`[secret-store] failed to delete replaced secret ${ref}: ${errMessage(err)}`);
      }
    }),
  );
}
