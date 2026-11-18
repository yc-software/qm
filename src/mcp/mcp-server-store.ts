import type { DurableMap } from "../persistence/durable-map.ts";
import { tenantListeners } from "../tenants/cache.ts";
import type { AttestAudience } from "../directory/person.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials" | "oauth-user";

export type McpApprovalPolicy = "annotations" | "all" | "none";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string[];
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
  about?: string;
  approval?: McpApprovalPolicy;
  catalog?: boolean;
  attestActor?: boolean;
  attestAudience?: AttestAudience;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
  version(): Promise<string>;
}

export function createMcpServerStore(backing: DurableMap<McpServer>): McpServerStore {
  const listeners = tenantListeners<[]>("mcp server change");
  return {
    async list() {
      const entries = await backing.entries();
      return entries.map(([, v]) => v).sort((a, b) => a.id.localeCompare(b.id));
    },
    get: (id) => backing.get(id),
    put: async (server) => {
      await backing.put(server.id, server);
      listeners.emit();
    },
    delete: async (id) => {
      await backing.delete(id);
      listeners.emit();
    },
    onChange: (listener) => listeners.add(listener),
    version: () => backing.version(),
  };
}
