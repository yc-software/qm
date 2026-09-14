import type { SecretVault } from "./types.ts";

export function createMemorySecretVault(): SecretVault {
  const records = new Map<string, { url: string; bearer: string }>();
  return {
    async put(id, value) {
      records.set(id, { ...value });
    },
    async get(id) {
      const value = records.get(id);
      return value ? { ...value } : null;
    },
    async delete(id) {
      records.delete(id);
    },
  };
}
