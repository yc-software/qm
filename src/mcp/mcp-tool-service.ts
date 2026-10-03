// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import { createHash } from "node:crypto";
import type { ConnectorTokenStore } from "../credentials/keychain.ts";
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

/** Anthropic and OpenAI both reject a request whose tool names exceed 64 chars of [a-zA-Z0-9_-]. */
const MAX_TOOL_NAME = 64;

/**
 * Namespaced model-facing name. Sanitizing can make two remote names collide (`list.items` vs
 * `list_items`) and long server ids push names past the provider limit, which fails EVERY turn
 * that carries the tool — so over-long or colliding names get a short stable hash suffix.
 */
export function mcpToolName(serverId: string, remoteName: string, taken: ReadonlySet<string>): string {
  const plain = `${serverId}_${remoteName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (plain.length <= MAX_TOOL_NAME && !taken.has(plain)) return plain;
  const hash = createHash("sha256").update(`${serverId}\0${remoteName}`).digest("hex").slice(0, 8);
  return `${plain.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : undefined;
}

function resolveLocalRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  const m = ref && /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  const target = m ? asSchema(asSchema(root[m[1]!])?.[decodeURIComponent(m[2]!)]) : undefined;
  return target ?? schema;
}

/**
 * Providers require a tool's top-level input schema to be `type: "object"`, and Anthropic rejects
 * top-level `anyOf`/`oneOf`/`allOf`. MCP servers ship all of these; one such tool used to make
 * every request carrying it 400. Nested schemas pass through untouched.
 */
export function providerSafeInputSchema(input: JsonSchema): JsonSchema {
  const top = resolveLocalRef(input, input);
  const branches = ["anyOf", "oneOf", "allOf"].flatMap((k) =>
    Array.isArray(top[k]) ? (top[k] as unknown[]).map(asSchema).filter((b): b is JsonSchema => !!b) : [],
  );
  const hasCombinator = ["anyOf", "oneOf", "allOf"].some((k) => k in top);
  if (top.type === "object" && !hasCombinator && top === input) return input;
  const properties: JsonSchema = { ...asSchema(top.properties) };
  for (const branch of branches) Object.assign(properties, asSchema(resolveLocalRef(branch, input).properties));
  let required: unknown[] = [];
  if (Array.isArray(top.allOf)) {
    required = branches.flatMap((b) => {
      const r = resolveLocalRef(b, input).required;
      return Array.isArray(r) ? (r as unknown[]) : [];
    });
  } else if (Array.isArray(top.required) && !hasCombinator) required = top.required;
  const out: JsonSchema = { type: "object", properties };
  if (required.length) out.required = [...new Set(required.filter((r): r is string => typeof r === "string"))];
  for (const key of ["$defs", "definitions"]) if (asSchema(input[key])) out[key] = input[key];
  if (typeof top.description === "string") out.description = top.description;
  if (hasCombinator) out.additionalProperties = true;
  return out;
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
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken">;
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
    if (!token) throw new Error(`Connect your account for MCP server ${server.id} before using this tool`);
    return createMcpClient({
      url: server.url,
      auth: { mode: "bearer", token },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
  }

  async function refresh(): Promise<void> {
    const servers = (await opts.servers.list()).filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    const taken = new Set<string>();
    for (const server of servers) {
      try {
        const tools = (await clientFor(server).listTools()).slice(0, MAX_TOOLS_PER_SERVER);
        for (const tool of tools) {
          const name = mcpToolName(server.id, tool.name, taken);
          if (taken.has(name)) continue;
          taken.add(name);
          next.push({
            name,
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: providerSafeInputSchema(tool.inputSchema),
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
        const result = await (await callerClient(server, principalId)).callTool(def.remoteName, args);
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
