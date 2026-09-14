import type { DurableMap } from "../persistence/durable-map.ts";
import type { SecretVault } from "./types.ts";

export interface StoredInboundSecret {
  url: string;
  bearer: string;
}

export function createDurableSecretVault(backing: DurableMap<StoredInboundSecret>): SecretVault {
  return {
    async put(id, value) {
      await backing.put(id, { url: value.url, bearer: value.bearer });
    },
    get: (id) => backing.get(id),
    delete: (id) => backing.delete(id),
  };
}
