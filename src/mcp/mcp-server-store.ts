// Registry of admin-configured MCP servers.
//
// Admin-only by design: registering a server points every scope's agents at
// an outbound HTTP endpoint, so end users must not be able to add one (SSRF
// and exfiltration surface). Secrets live in the record like other stored
// connector credentials — reachable only through core, never injected into sandboxes.

import type { DurableMap } from "../persistence/durable-map.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
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
}

export function createMcpServerStore(backing: DurableMap<McpServer>): McpServerStore {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    async list() {
      const entries = await backing.entries();
      return entries.map(([, v]) => v).sort((a, b) => a.id.localeCompare(b.id));
    },
    get: (id) => backing.get(id),
    put: async (server) => {
      await backing.put(server.id, server);
      emit();
    },
    delete: async (id) => {
      await backing.delete(id);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
