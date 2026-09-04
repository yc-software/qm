// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import type { AuditLog } from "../audit/audit-log.ts";
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

export function mcpToolsForTurn(
  turnTools: readonly McpToolDescriptor[] | undefined,
  fallback?: () => McpToolDescriptor[],
): (() => McpToolDescriptor[]) | undefined {
  return turnTools === undefined ? fallback : () => [...turnTools];
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(context?: McpCallContext): Promise<McpToolDescriptor[]>;
  /** Current unfiltered snapshot for privileged connector administration. */
  allToolDefs(): McpToolDescriptor[];
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(name: string, args: Record<string, unknown>, context?: McpCallContext | string): Promise<string>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  /** Probe a server config without persisting it. Returns its tool names. */
  probe(server: McpServer): Promise<string[]>;
  close(): void;
}

export interface McpCallContext {
  principalId: string;
  scopeId: string;
  runId?: string;
}

export interface McpAuthorizationTarget {
  action: "discover" | "call";
  serverId: string;
  toolName: string;
}

export interface McpAuthorization {
  allowed: boolean;
  authorization?: string;
  headers?: Record<string, string>;
}

export type McpAuthorizer = (
  context: Readonly<McpCallContext>,
  target: Readonly<McpAuthorizationTarget>,
) => Promise<McpAuthorization>;

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
  authorize?: McpAuthorizer;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
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

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
    clients.set(server.id, { client, server });
    return client;
  }

  function contextFor(context: McpCallContext | string | undefined): McpCallContext | undefined {
    if (!context || typeof context === "string") return undefined;
    if (
      typeof context.principalId !== "string" ||
      !context.principalId.trim() ||
      typeof context.scopeId !== "string" ||
      !context.scopeId.trim() ||
      (context.runId !== undefined && (typeof context.runId !== "string" || !context.runId.trim()))
    ) {
      return undefined;
    }
    return Object.freeze({
      principalId: context.principalId,
      scopeId: context.scopeId,
      ...(context.runId ? { runId: context.runId } : {}),
    });
  }

  async function authorize(
    context: McpCallContext | undefined,
    target: McpAuthorizationTarget,
  ): Promise<McpAuthorization | null> {
    if (!opts.authorize) return { allowed: true };
    if (!context) return null;
    let decision: McpAuthorization;
    try {
      decision = await opts.authorize(context, Object.freeze({ ...target }));
    } catch {
      throw new Error("MCP authorization failed");
    }
    return decision.allowed ? decision : null;
  }

  function callHeaders(server: McpServer, decision: McpAuthorization): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(decision.headers ?? {})) {
      const normalized = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) || /[\r\n]/.test(value)) {
        throw new Error("MCP authorization returned an invalid header");
      }
      if (
        [
          "authorization",
          "content-type",
          "accept",
          "host",
          "content-length",
          "connection",
          "transfer-encoding",
        ].includes(normalized)
      ) {
        throw new Error(`MCP authorization cannot set reserved header ${normalized}`);
      }
      headers[normalized] = value;
    }
    if (decision.authorization !== undefined) {
      if (!decision.authorization || /[\r\n]/.test(decision.authorization)) {
        throw new Error("MCP authorization returned an invalid authorization value");
      }
      if (server.auth !== "none") {
        throw new Error("MCP authorization cannot add authorization to a statically authenticated MCP server");
      }
      headers.authorization = decision.authorization;
    }
    return headers;
  }

  async function refresh(): Promise<void> {
    const servers = (await opts.servers.list()).filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    for (const server of servers) {
      try {
        const tools = (await clientFor(server).listTools()).slice(0, MAX_TOOLS_PER_SERVER);
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
        record("list", server.id, `ok tools=${tools.length}`);
      } catch {
        record("list", server.id, "error");
      }
    }
    // De-duplicate on the namespaced name; first server wins deterministically.
    const seen = new Set<string>();
    snapshot = next.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }

  const unsubscribe = opts.servers.onChange(() => {
    void refresh();
  });
  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  void refresh();

  return {
    allToolDefs: () => snapshot,
    async toolDefs(context) {
      const callContext = contextFor(context);
      if (opts.authorize && !callContext) return [];
      const allowed = await Promise.all(
        snapshot.map(async (def) => {
          const decision = await authorize(callContext, {
            action: "discover",
            serverId: def.serverId,
            toolName: def.remoteName,
          });
          return decision ? def : null;
        }),
      );
      return allowed.filter((def): def is McpToolDescriptor => def !== null);
    },
    async call(name, args, context) {
      const callContext = contextFor(context);
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        const decision = await authorize(callContext, {
          action: "call",
          serverId: def.serverId,
          toolName: def.remoteName,
        });
        if (!decision) throw new Error("MCP tool is not authorized for this context");
        const result = await clientFor(server).callTool(def.remoteName, args, callHeaders(server, decision));
        record(
          "call",
          `${def.serverId}/${def.remoteName}`,
          "ok",
          callContext?.principalId ?? (typeof context === "string" ? context : undefined),
        );
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        record(
          "call",
          `${def.serverId}/${def.remoteName}`,
          "error",
          callContext?.principalId ?? (typeof context === "string" ? context : undefined),
        );
        throw e;
      }
    },
    refresh,
    async probe(server) {
      const client = createMcpClient({
        url: server.url,
        auth: authOf(server),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      });
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
