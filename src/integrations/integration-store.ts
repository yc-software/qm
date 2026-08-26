import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";

type IntegrationAccess = "read" | "read-write";

export interface IntegrationConnection {
  accountId: string;
  externalUserId: string;
  ownerId: string;
  appSlug: string;
  appName: string;
  accountName: string;
  targetRequired?: boolean;
  target?: {
    type: string;
    id: string;
    name: string;
    verified: true;
  };
  lastVerifiedTargetId?: string;
  providerUpdatedAt?: number;
  imageUrl?: string;
  healthy: boolean;
  scopes: ScopeId[];
  access: IntegrationAccess;
  disconnectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationConnectionStore {
  list(): Promise<IntegrationConnection[]>;
  get(accountId: string): Promise<IntegrationConnection | null>;
  put(connection: IntegrationConnection): Promise<void>;
  putIfAbsent(connection: IntegrationConnection): Promise<IntegrationConnection>;
  update(
    accountId: string,
    fn: (connection: IntegrationConnection) => IntegrationConnection,
  ): Promise<IntegrationConnection | null>;
  delete(accountId: string): Promise<void>;
}

export function createIntegrationConnectionStore(
  backing: DurableMap<IntegrationConnection>,
): IntegrationConnectionStore {
  return {
    async list() {
      return (await backing.all()).sort(
        (a, b) => a.appName.localeCompare(b.appName) || a.accountId.localeCompare(b.accountId),
      );
    },
    get: (accountId) => backing.get(accountId),
    put: (connection) => backing.put(connection.accountId, connection),
    putIfAbsent: (connection) => backing.putIfAbsent(connection.accountId, connection),
    update: (accountId, fn) => {
      if (!backing.update) throw new Error("integration store requires atomic updates");
      return backing.update(accountId, fn);
    },
    delete: (accountId) => backing.delete(accountId),
  };
}
