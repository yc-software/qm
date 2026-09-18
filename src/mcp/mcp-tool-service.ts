// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import { brokerCredentialAuthHeader, brokerCredentialTargetError } from "../api/credential-broker.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import type { Principal, ScopeId } from "../types.ts";
import type {
  ConnectorTokenStore,
  DecryptedServiceCredential,
  ServiceCredentialReader,
} from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;

export interface McpToolDescriptor {
  /** Namespaced tool name exposed to the model, e.g. "salesforce_query". */
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpCallContext {
  audience: readonly Principal[];
  scopeId: ScopeId;
  orgScopeId: ScopeId;
  /** Same internal-only gate as service credential delivery, including publish members. */
  allInternal: boolean;
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(): McpToolDescriptor[];
  /** Turn-scoped snapshot under the existing service credential audience floor. */
  authorizedToolDefs(context: McpCallContext): Promise<McpToolDescriptor[]>;
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(name: string, args: Record<string, unknown>, principalId?: string, context?: McpCallContext): Promise<string>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  /** Probe a server config without persisting it. Returns its tool names. */
  probe(server: McpServer): Promise<string[]>;
  close(): void;
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  acl?: Pick<AclStore, "grantsOfKind">;
  serviceCreds?: ServiceCredentialReader;
  orgScopeId?: ScopeId;
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken">;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  let snapshot: McpToolDescriptor[] = [];
  let snapshotServers = new Map<string, string>();
  let generation = 0;
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

  async function credentialFor(server: McpServer): Promise<DecryptedServiceCredential | null> {
    if (!server.serviceCredential) return null;
    const rec = opts.orgScopeId
      ? await opts.serviceCreds?.getServiceCredentialSecret(opts.orgScopeId, server.serviceCredential)
      : null;
    // Catalog refresh has no live actor to attest. Client credentials use the
    // secret in the OAuth body, so custom header injection does not apply.
    if (
      !rec?.enabled ||
      !rec.secret ||
      rec.delivery !== "broker" ||
      rec.injection?.actor ||
      (server.credentialScope ?? "shared") !== "shared" ||
      server.auth === "none"
    ) {
      throw new Error("MCP service credential is unavailable");
    }
    if (server.auth === "client-credentials") {
      const [header, scheme] = brokerCredentialAuthHeader({ ...rec, secret: "" });
      if (header.toLowerCase() !== "authorization" || scheme !== "Bearer ") {
        throw new Error("MCP service credential is unavailable");
      }
    }
    return rec;
  }

  async function authorize(server: McpServer, context?: McpCallContext): Promise<void> {
    if (!server.serviceCredential) return;
    if (
      !context?.allInternal ||
      !context.audience.length ||
      context.audience.some((p) => p.type !== "internal") ||
      !opts.acl ||
      context.orgScopeId !== opts.orgScopeId
    ) {
      throw new Error("MCP credential is not authorized in this conversation");
    }
    const grants = await opts.acl.grantsOfKind(
      "service-cred",
      context.audience,
      context.scopeId,
      context.orgScopeId,
      principalEntitledToScope,
    );
    if (!grants.some((g) => parseRef(g.ref).id === server.serviceCredential)) {
      throw new Error("MCP credential is not authorized in this conversation");
    }
  }

  async function clientFor(server: McpServer, context?: McpCallContext): Promise<McpClient> {
    const credential = await credentialFor(server);
    // Re-read custody and transport policy before consulting any cached client.
    const cacheKey = JSON.stringify([server, credential, credential ? context : null]);
    const cached = clients.get(cacheKey);
    if (cached) return cached.client;
    let auth = authOf(server);
    if (credential) {
      auth =
        server.auth === "bearer"
          ? { mode: "bearer", token: credential.secret }
          : { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: credential.secret };
    }
    const upstream: McpFetch = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, redirect: "error" }));
    const fetchImpl: McpFetch = credential
      ? async (url, init) => {
          if (context) {
            const current = await opts.servers.get(server.id);
            if (
              !current?.enabled ||
              JSON.stringify(current) !== JSON.stringify(server) ||
              JSON.stringify(await credentialFor(server)) !== JSON.stringify(credential)
            ) {
              throw new Error("MCP server or credential changed during the call");
            }
            await authorize(server, context);
          }
          const error = brokerCredentialTargetError(credential, url, init.method);
          if (error) throw new Error(`MCP credential target denied: ${error.code}`);
          const headers = { ...init.headers };
          if (server.auth === "bearer") {
            delete headers.authorization;
            const [header, value] = brokerCredentialAuthHeader(credential);
            headers[header] = value;
          }
          return upstream(url, { ...init, headers });
        }
      : upstream;
    const client = createMcpClient({ url: server.url, auth, fetchImpl, now });
    for (const [key, entry] of clients) if (entry.server.id === server.id) clients.delete(key);
    clients.set(cacheKey, { client, server });
    return client;
  }

  async function callerClient(server: McpServer, principalId?: string, context?: McpCallContext): Promise<McpClient> {
    if ((server.credentialScope ?? "shared") === "shared") return clientFor(server, context);
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
    return createMcpClient({
      url: server.url,
      auth: { mode: "bearer", token },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
  }

  async function refresh(): Promise<void> {
    const refreshing = ++generation;
    const nextServers = new Map<string, string>();
    const servers = (await opts.servers.list()).filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    for (const server of servers) {
      try {
        const tools = (await (await clientFor(server)).listTools()).slice(0, MAX_TOOLS_PER_SERVER);
        for (const tool of tools) {
          next.push({
            name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: tool.inputSchema,
            readOnly: server.readOnly,
          });
        }
        nextServers.set(server.id, JSON.stringify(server));
        record("list", server.id, `ok tools=${tools.length}`);
      } catch (e) {
        record("list", server.id, `error: ${errMessage(e)}`);
      }
    }
    if (closed || refreshing !== generation) return;
    snapshotServers = nextServers;
    // De-duplicate on the namespaced name; first server wins deterministically.
    const seen = new Set<string>();
    snapshot = next.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }

  const unsubscribe = opts.servers.onChange(() => {
    snapshot = [];
    snapshotServers.clear();
    void refresh();
  });
  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  void refresh();

  return {
    toolDefs: () => snapshot,
    async authorizedToolDefs(context) {
      const exposingGeneration = generation;
      const allowed = new Set<string>();
      for (const server of await opts.servers.list()) {
        if (!server.enabled || snapshotServers.get(server.id) !== JSON.stringify(server)) continue;
        try {
          await credentialFor(server);
          await authorize(server, context);
          if (JSON.stringify(await opts.servers.get(server.id)) === JSON.stringify(server)) allowed.add(server.id);
        } catch {
          // A missing or revoked credential never falls back to inline auth.
        }
      }
      return exposingGeneration === generation ? snapshot.filter((tool) => allowed.has(tool.serverId)) : [];
    },
    async call(name, args, principalId, context) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const expectedServer = snapshotServers.get(def.serverId);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled || expectedServer !== JSON.stringify(server))
        throw new Error(`MCP server ${def.serverId} is not available`);
      const recheck = async () => {
        if (!server.serviceCredential) return;
        const current = await opts.servers.get(server.id);
        if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(server)) {
          throw new Error("MCP server changed during the call");
        }
        await credentialFor(server);
        await authorize(server, context);
      };
      try {
        await authorize(server, context);
        const result = await (await callerClient(server, principalId, context)).callTool(def.remoteName, args);
        await recheck();
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        // Revocation also suppresses an upstream error containing protected data.
        try {
          await recheck();
        } catch (denied) {
          record("call", `${def.serverId}/${def.remoteName}`, "denied", principalId);
          throw denied;
        }
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server) {
      const client = await clientFor(server);
      const tools = await client.listTools();
      return tools.map((t) => t.name);
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
