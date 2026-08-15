// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;
const MAX_SCHEMA_NODES = 20_000;
const MAX_SCHEMA_DEPTH = 100;

export interface McpToolDescriptor {
  /** Namespaced tool name exposed to the model, e.g. "salesforce_query". */
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(): McpToolDescriptor[];
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  /** Probe a server config without persisting it. Returns its tool names. */
  probe(server: McpServer): Promise<string[]>;
  close(): void;
}

function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node)) node = node[Number(key)];
    else if (node && typeof node === "object") node = (node as Record<string, unknown>)[key];
    else return undefined;
  }
  return node;
}

function expandRef(
  ref: string,
  root: unknown,
  stack: string[],
  budget: { left: number },
  depth: number,
): Record<string, unknown> {
  if (stack.includes(ref)) return {};
  const target = resolvePointer(root, ref);
  if (typeof target === "boolean") return target ? {} : { not: {} };
  if (!target || typeof target !== "object" || Array.isArray(target)) return {};
  return inlineRefs(target, root, [...stack, ref], budget, depth) as Record<string, unknown>;
}

function inlineRefs(
  node: unknown,
  root: unknown,
  stack: string[],
  budget: { left: number },
  depth = 0,
): unknown {
  if (budget.left <= 0 || depth > MAX_SCHEMA_DEPTH) return Array.isArray(node) ? [] : {};
  budget.left -= 1;
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, root, stack, budget, depth + 1));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const siblings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$ref" || k === "$defs" || k === "definitions" || k === "__proto__") continue;
    siblings[k] = inlineRefs(v, root, stack, budget, depth + 1);
  }
  if (typeof obj.$ref !== "string") return siblings;
  return { ...expandRef(obj.$ref, root, stack, budget, depth + 1), ...siblings };
}

export function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const inlined = inlineRefs(schema, schema, [], { left: MAX_SCHEMA_NODES });
  if (!inlined || typeof inlined !== "object" || Array.isArray(inlined)) return objectSchemaFallback();
  const out = inlined as Record<string, unknown>;
  if (out.type === "object") return out;
  if (out.type === undefined && out.properties && typeof out.properties === "object") {
    return { ...out, type: "object" };
  }
  return objectSchemaFallback();
}

function objectSchemaFallback(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: true };
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
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
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
            inputSchema: sanitizeToolSchema(tool.inputSchema),
            readOnly: server.readOnly,
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
    toolDefs: () => snapshot,
    async call(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        const result = await clientFor(server).callTool(def.remoteName, args);
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
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
