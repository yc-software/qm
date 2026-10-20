import { LRUCache } from "lru-cache";
import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage, reportFailureAs, swallow } from "../util/errors.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;
const MAX_TOOL_NAME = 64;
const MAX_USER_CLIENTS = 256;

export interface McpToolDescriptor {
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpToolService {
  toolDefs(): McpToolDescriptor[];
  call(name: string, args: Record<string, unknown>, principalId?: string, signal?: AbortSignal): Promise<string>;
  refresh(): Promise<void>;
  probe(server: McpServer): Promise<string[]>;
  close(): void;
}

interface CachedClient {
  client: McpClient;
  key: string;
  active: number;
  retired: boolean;
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

function toolName(serverId: string, remoteName: string): string {
  return `${serverId}_${remoteName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

const COMBINATORS = ["oneOf", "anyOf", "allOf", "not", "enum", "const"];

function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const top = Object.fromEntries(Object.entries(schema).filter(([key]) => !COMBINATORS.includes(key)));
  return { ...top, type: "object", properties: top.properties ?? {} };
}

function closeQuietly(client: McpClient): void {
  void client.close().catch((error: unknown) => swallow("mcp: close client", error));
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken">;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new LRUCache<string, CachedClient>({ max: MAX_USER_CLIENTS, disposeAfter: (entry) => retire(entry) });
  let snapshot: McpToolDescriptor[] = [];
  let closed = false;

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `mcp.${action}`,
      resource,
      scopeLabel: "mcp-connectors",
      status,
    });
  }

  function newClient(server: McpServer, auth: McpAuth): McpClient {
    return createMcpClient({ url: server.url, auth, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  }

  function retire(entry: CachedClient): void {
    entry.retired = true;
    if (!entry.active) closeQuietly(entry.client);
  }

  async function use<T>(entry: CachedClient, run: (client: McpClient) => Promise<T>): Promise<T> {
    entry.active++;
    try {
      return await run(entry.client);
    } finally {
      entry.active--;
      if (entry.retired && !entry.active) closeQuietly(entry.client);
    }
  }

  function cached(slot: string, key: string, make: () => McpClient): CachedClient {
    const hit = clients.get(slot);
    if (hit?.key === key) return hit;
    const entry: CachedClient = { client: make(), key, active: 0, retired: false };
    clients.set(slot, entry);
    return entry;
  }

  function clientFor(server: McpServer): CachedClient {
    return cached(`shared\0${server.id}`, JSON.stringify(server), () => newClient(server, authOf(server)));
  }

  async function callerClient(server: McpServer, principalId?: string): Promise<CachedClient> {
    if ((server.credentialScope ?? "shared") === "shared") return clientFor(server);
    if (server.credentialScope !== "per-user") throw new Error("invalid MCP credential scope");
    if (!principalId || !server.credentialHost || !opts.userTokens) {
      throw new Error(`MCP server ${server.id} requires a connected user account`);
    }
    const token = await opts.userTokens.connectorAccessToken(
      server.credentialHost,
      principalId,
      server.credentialAccountType,
    );
    if (!token) throw new Error(`Connect your account for MCP server ${server.id} before using this tool`);
    return cached(`user\0${server.id}\0${principalId}`, `${JSON.stringify(server)}\0${token}`, () =>
      newClient(server, { mode: "bearer", token }),
    );
  }

  async function refresh(): Promise<void> {
    const servers = (await opts.servers.list()).filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    const seen = new Set<string>();
    for (const server of servers) {
      try {
        const tools = await use(clientFor(server), (client) => client.listTools(MAX_TOOLS_PER_SERVER));
        const dropped: string[] = [];
        for (const tool of tools) {
          const name = toolName(server.id, tool.name);
          if (seen.has(name)) {
            dropped.push(tool.name);
            continue;
          }
          seen.add(name);
          next.push({
            name,
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: objectSchema(tool.inputSchema),
            readOnly: server.readOnly,
          });
        }
        record("list", server.id, `ok tools=${tools.length}${dropped.length ? ` dropped=${dropped.join(",")}` : ""}`);
      } catch (e) {
        record("list", server.id, `error: ${errMessage(e)}`);
      }
    }
    snapshot = next;
  }

  const refreshInBackground = (): void => {
    if (!closed) void refresh().catch(reportFailureAs("mcp: refresh tools", undefined));
  };
  const unsubscribe = opts.servers.onChange(refreshInBackground);
  const timer = setInterval(refreshInBackground, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  refreshInBackground();

  return {
    toolDefs: () => snapshot,
    async call(name, args, principalId, signal) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        const entry = await callerClient(server, principalId);
        const result = await use(entry, (client) => client.callTool(def.remoteName, args, signal ? { signal } : {}));
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result);
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server) {
      const client = newClient(server, authOf(server));
      try {
        return (await client.listTools(MAX_TOOLS_PER_SERVER)).map((t) => t.name);
      } finally {
        closeQuietly(client);
      }
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
      clients.clear();
    },
  };
}
