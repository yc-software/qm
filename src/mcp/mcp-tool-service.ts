// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_CHARS = 1_000_000;
const MAX_SCHEMA_REFRESH_CHARS = MAX_SCHEMA_CHARS * 2;
const SCHEMA_VALUES = new Set(
  "additionalItems additionalProperties contains contentSchema else if not propertyNames then unevaluatedItems unevaluatedProperties".split(
    " ",
  ),
);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAPS = new Set(["dependentSchemas", "patternProperties", "properties"]);
const REF_ANNOTATIONS = new Set("$comment default deprecated description examples readOnly title writeOnly".split(" "));
const REF_SIBLINGS = new Set(
  `${[...REF_ANNOTATIONS].join(" ")} type multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern format maxItems minItems uniqueItems maxProperties minProperties`.split(
    " ",
  ),
);

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

type SchemaLocation = "array" | "dependencies" | "map" | "schema";

interface SchemaBudget {
  chars: number;
  nodes: number;
  refs: boolean;
  scoped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chargeSchema(budget: SchemaBudget, chars: number): void {
  if ((budget.chars -= chars) < 0) throw new Error("unsupported MCP tool schema");
}

function keepSchemaValue(value: unknown, budget: SchemaBudget): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("unsupported MCP tool schema");
  chargeSchema(budget, json.length);
  return value;
}

function resolveSchemaPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  let value = root;
  for (const token of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(token) || (value !== root && isRecord(value) && typeof value.$id === "string"))
      return undefined;
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return undefined;
    } else if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function schemaLocation(key: string, value: unknown): SchemaLocation | undefined {
  if (SCHEMA_MAPS.has(key)) return "map";
  if (SCHEMA_ARRAYS.has(key) || (key === "items" && Array.isArray(value))) return "array";
  if (key === "dependencies") return "dependencies";
  if (SCHEMA_VALUES.has(key) || key === "items") return "schema";
  return undefined;
}

function normalizeSchema(
  value: unknown,
  root: unknown,
  active: Set<unknown>,
  budget: SchemaBudget,
  depth = 0,
  location: SchemaLocation = "schema",
): unknown {
  if (depth > MAX_SCHEMA_DEPTH || budget.nodes-- <= 0) throw new Error("unsupported MCP tool schema");
  if (location === "array") {
    if (!Array.isArray(value)) return keepSchemaValue(value, budget);
    chargeSchema(budget, Math.max(2, value.length + 1));
    return value.map((item) => normalizeSchema(item, root, active, budget, depth + 1));
  }
  if (location === "map" || location === "dependencies") {
    if (!isRecord(value)) return keepSchemaValue(value, budget);
    const mapEntries = Object.entries(value);
    chargeSchema(
      budget,
      mapEntries.reduce((chars, [key]) => chars + JSON.stringify(key).length + 2, 2),
    );
    return Object.fromEntries(
      mapEntries.map(([key, child]) => [
        key,
        location === "dependencies" && Array.isArray(child)
          ? keepSchemaValue(child, budget)
          : normalizeSchema(child, root, active, budget, depth + 1),
      ]),
    );
  }
  if (typeof value === "boolean") {
    chargeSchema(budget, value ? 4 : 5);
    return value;
  }
  if (!isRecord(value)) return keepSchemaValue(value, budget);
  if (Object.hasOwn(value, "$dynamicRef") || Object.hasOwn(value, "$recursiveRef"))
    throw new Error("unsupported MCP tool schema");
  if (
    (depth > 0 && typeof value.$id === "string") ||
    Object.hasOwn(value, "$anchor") ||
    Object.hasOwn(value, "$dynamicAnchor") ||
    Object.hasOwn(value, "$recursiveAnchor")
  )
    budget.scoped = true;
  const sourceEntries = Object.entries(value);
  chargeSchema(
    budget,
    sourceEntries.reduce((chars, [key]) => chars + JSON.stringify(key).length + 2, 2),
  );
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of sourceEntries) {
    if (key === "$ref") {
      keepSchemaValue(child, budget);
      continue;
    }
    if (key === "$defs" || key === "definitions") {
      normalizeSchema(child, root, active, budget, depth + 1, "map");
      continue;
    }
    const childLocation = schemaLocation(key, child);
    entries.push([
      key,
      childLocation
        ? normalizeSchema(child, root, active, budget, depth + 1, childLocation)
        : keepSchemaValue(child, budget),
    ]);
  }
  const siblings = Object.fromEntries(entries);
  if (!Object.hasOwn(value, "$ref")) return siblings;
  budget.refs = true;
  if (typeof value.$ref !== "string") throw new Error("unsupported MCP tool schema");
  const target = resolveSchemaPointer(root, value.$ref);
  if (
    target === undefined ||
    active.has(target) ||
    (target !== root && isRecord(target) && typeof target.$id === "string")
  )
    throw new Error("unsupported MCP tool schema");
  if (target === true) return siblings;
  if (target === false) return false;
  if (!isRecord(target)) throw new Error("unsupported MCP tool schema");
  active.add(target);
  const normalized = normalizeSchema(target, root, active, budget, depth + 1);
  active.delete(target);
  if (!isRecord(normalized)) return normalized;
  for (const key of Object.keys(siblings)) {
    if (!REF_SIBLINGS.has(key) || (Object.hasOwn(normalized, key) && !REF_ANNOTATIONS.has(key)))
      throw new Error("unsupported MCP tool schema");
  }
  return Object.fromEntries([...Object.entries(normalized), ...Object.entries(siblings)]);
}

function normalizeToolSchema(
  schema: Record<string, unknown>,
  maxChars: number,
): { chars: number; schema: Record<string, unknown> } | null {
  const chars = Math.min(MAX_SCHEMA_CHARS, maxChars);
  const budget: SchemaBudget = {
    chars,
    nodes: MAX_SCHEMA_NODES,
    refs: false,
    scoped: false,
  };
  try {
    const normalized = normalizeSchema(schema, schema, new Set(), budget);
    const output = budget.refs ? normalized : schema;
    return (!budget.refs || !budget.scoped) && isRecord(output) && output.type === "object"
      ? { chars: chars - budget.chars, schema: output }
      : null;
  } catch {
    return null;
  }
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
    let schemaChars = MAX_SCHEMA_REFRESH_CHARS;
    for (const server of servers) {
      try {
        const tools = (await clientFor(server).listTools()).slice(0, MAX_TOOLS_PER_SERVER);
        for (const tool of tools) {
          const normalized = normalizeToolSchema(tool.inputSchema, schemaChars);
          if (!normalized) continue;
          schemaChars -= normalized.chars;
          next.push({
            name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: normalized.schema,
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
