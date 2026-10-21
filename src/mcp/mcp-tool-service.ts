// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { setPublicOAuthClients, type PublicOAuthClient } from "../connectors/oauth.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_RESULT_CHARS = 60_000;
const DROPPED_OPTIONAL_PARAMS = ["intent", "locale"];

function modelInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const dropped = DROPPED_OPTIONAL_PARAMS.filter((name) => Object.hasOwn(properties, name) && !required.has(name));
  if (!dropped.length) return schema;
  const kept = { ...(properties as Record<string, unknown>) };
  for (const name of dropped) delete kept[name];
  return { ...schema, properties: kept };
}

function mcpToolNeedsApproval(
  server: Pick<McpServer, "approval">,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
): boolean {
  const policy = server.approval ?? "annotations";
  if (policy !== "annotations") return policy === "all";
  return annotations?.destructiveHint === true && annotations.readOnlyHint !== true;
}

export function mcpPublicOAuthClients(servers: McpServer[]): PublicOAuthClient[] {
  return servers.flatMap((s) =>
    s.enabled && s.auth === "oauth-user" && s.clientId && s.oauthAuthorizeUrl && s.oauthTokenUrl && s.credentialHost
      ? [
          {
            name: s.id,
            host: s.credentialHost,
            authUrl: s.oauthAuthorizeUrl,
            tokenUrl: s.oauthTokenUrl,
            scopes: s.oauthScopes ?? [],
            clientId: s.clientId,
            resource: s.url,
            label: s.name,
          },
        ]
      : [],
  );
}

export interface McpToolDescriptor {
  /** Namespaced tool name exposed to the model, e.g. "salesforce_query". */
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  needsApproval: boolean;
  signIn?: true;
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(): McpToolDescriptor[];
  toolDefsFor(principalId?: string): Promise<McpToolDescriptor[]>;
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  /** Probe a server config without persisting it. Returns its tool names. */
  probe(server: McpServer): Promise<string[]>;
  close(): void;
}

class SignInRequired extends Error {}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken" | "connectorTokenStatus">;
  now?: () => number;
  refreshIntervalMs?: number;
  signInUrl?: (serverId: string) => string;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  let snapshot: McpToolDescriptor[] = [];
  let perUserServers = new Map<string, McpServer>();

  function signInMessage(server: McpServer): string {
    const url = opts.signInUrl?.(server.id);
    return url
      ? `Sign in to ${server.name} first: [Connect ${server.name}](${url}). Then try again.`
      : `Sign in to ${server.name} from the Connectors page first, then try again.`;
  }
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

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    const client = createMcpClient({ url: server.url, auth: authOf(server) });
    clients.set(server.id, { client, server });
    return client;
  }

  async function callerClient(server: McpServer, principalId?: string): Promise<McpClient> {
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
    if (!token) {
      if (server.auth === "oauth-user") throw new SignInRequired(signInMessage(server));
      throw new Error(`Connect your account for MCP server ${server.id} before using this tool`);
    }
    return createMcpClient({ url: server.url, auth: { mode: "bearer", token } });
  }

  async function refresh(): Promise<void> {
    const all = await opts.servers.list();
    setPublicOAuthClients(mcpPublicOAuthClients(all));
    const servers = all.filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    const nextPerUser = new Map<string, McpServer>();
    for (const server of servers) {
      try {
        let tools: NonNullable<McpServer["tools"]>;
        if (server.auth === "oauth-user") {
          nextPerUser.set(server.id, server);
          next.push({
            name: `${server.id}_sign_in`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            remoteName: "sign_in",
            signIn: true,
            description: `Connect your own ${server.name} account and load its tools. Call this before anything else on ${server.name}.`,
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
            needsApproval: false,
          });
          tools = server.tools ?? [];
          if (!tools.length) continue;
        } else tools = await clientFor(server).listTools();
        for (const tool of tools) {
          next.push({
            name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: modelInputSchema(tool.inputSchema),
            readOnly: server.readOnly,
            needsApproval: mcpToolNeedsApproval(server, tool.annotations),
          });
        }
        record("list", server.id, `ok tools=${tools.length}`);
      } catch (e) {
        record("list", server.id, `error: ${errMessage(e)}`);
      }
    }
    // De-duplicate on the namespaced name; first server wins deterministically.
    const seen = new Set<string>();
    snapshot = next.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    perUserServers = nextPerUser;
  }

  async function connected(server: McpServer, principalId: string | undefined): Promise<boolean> {
    if (!principalId || !server.credentialHost || !opts.userTokens) return false;
    const status = await opts.userTokens
      .connectorTokenStatus(server.credentialHost, principalId, server.credentialAccountType)
      .catch(reportFailureAs("mcp: connector status", null));
    return Boolean(status?.connected && !status.needsReconnect);
  }

  async function toolDefsFor(principalId?: string): Promise<McpToolDescriptor[]> {
    const current = snapshot;
    const gated = perUserServers;
    if (!gated.size) return current;
    const withTools = new Set(current.filter((t) => gated.has(t.serverId) && !t.signIn).map((t) => t.serverId));
    const ready = new Set<string>();
    await Promise.all(
      [...withTools].map(async (id) => {
        if (await connected(gated.get(id)!, principalId)) ready.add(id);
      }),
    );
    return current.filter((t) => !gated.has(t.serverId) || Boolean(t.signIn) !== ready.has(t.serverId));
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
    toolDefsFor,
    async call(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        const client = await callerClient(server, principalId);
        if (def.signIn) {
          const tools = await client.listTools();
          const current = await opts.servers.get(server.id);
          if (current) await opts.servers.put({ ...current, tools });
          await refresh();
          record("call", `${def.serverId}/sign_in`, `ok tools=${tools.length}`, principalId);
          return `Signed in to ${server.name}. Tools now available: ${tools.map((t) => `${server.id}_${t.name}`).join(", ")}`;
        }
        const result = await client.callTool(def.remoteName, args);
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        if (e instanceof SignInRequired) {
          record("call", `${def.serverId}/${def.remoteName}`, "sign-in required", principalId);
          return e.message;
        }
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server) {
      const tools = await createMcpClient({ url: server.url, auth: authOf(server) }).listTools();
      return tools.map((t) => t.name);
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
