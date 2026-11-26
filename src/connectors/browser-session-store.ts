import type { DurableMap } from "../persistence/durable-map.ts";
import type { SecretKey } from "./connector-client-store.ts";
import {
  createEncryptedSecretStore,
  deleteReplacedSecrets,
  type SecretStoreFactory,
} from "../credentials/secret-store.ts";
import { swallow } from "../util/errors.ts";

export interface BrowserSessionStore {
  get(principalId: string): Promise<string | null>;
  put(principalId: string, storageStateJson: string): Promise<void>;
}

export interface StoredBrowserSession {
  principalId: string;
  stateEnc: string;
  updatedAt: number;
}

export function createBrowserSessionStore(deps: {
  sessions: DurableMap<StoredBrowserSession>;
  key: SecretKey;
  secrets?: SecretStoreFactory;
  now?: () => number;
}): BrowserSessionStore {
  const now = deps.now ?? Date.now;
  const secrets = (deps.secrets ?? createEncryptedSecretStore)(deps.key);
  return {
    async get(principalId) {
      const rec = await deps.sessions.get(principalId);
      if (!rec) return null;
      try {
        return await secrets.get(rec.stateEnc);
      } catch (e) {
        swallow(`browser-session decrypt ${principalId}`, e);
        return null;
      }
    },
    async put(principalId, storageStateJson) {
      const previous = await deps.sessions.get(principalId);
      const stateEnc = await secrets.put(`browser-sessions/${principalId}`, storageStateJson);
      await deps.sessions.put(principalId, { principalId, stateEnc, updatedAt: now() });
      await deleteReplacedSecrets(secrets, [previous?.stateEnc], [stateEnc]);
    },
  };
}
