import type { BrowserSessionRows } from "./link-tables.ts";
import { encryptSecret, decryptSecret, type SecretKey } from "./connector-client-store.ts";
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
  sessions: BrowserSessionRows;
  key: SecretKey;
  now?: () => number;
}): BrowserSessionStore {
  const now = deps.now ?? Date.now;
  return {
    async get(principalId) {
      const rec = await deps.sessions.get(principalId);
      if (!rec) return null;
      try {
        return decryptSecret(rec.stateEnc, deps.key);
      } catch (e) {
        swallow(`browser-session decrypt ${principalId}`, e);
        return null;
      }
    },
    async put(principalId, storageStateJson) {
      await deps.sessions.put({
        principalId,
        stateEnc: encryptSecret(storageStateJson, deps.key),
        updatedAt: now(),
      });
    },
  };
}
