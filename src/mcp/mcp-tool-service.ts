import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  createMcpClient,
  mcpResultText,
  validateMcpToolArguments,
  type McpAuth,
  type McpClient,
  type McpFetch,
  type McpRemoteTool,
  type McpResolveHost,
} from "./mcp-client.ts";
import type { McpAllowedTool, McpServer, McpServerStore } from "./mcp-server-store.ts";
import type { McpAuthoritySigner, McpHumanCallContext } from "./mcp-authority.ts";
import { parseAnalyticsNativeDelivery } from "./mcp-native-card.ts";
import type { TrustedAnalyticsCard } from "../types.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;
const RESERVED_TOOL_NAMES = new Set([
  "execute",
  "credential_exec",
  "read",
  "write",
  "publish",
  "miniapp",
  "memory",
  "history",
  "background",
  "cron",
  "webhook",
  "share",
  "guidance",
  "finish_silently",
  "stay_silent",
  "create_goal",
  "get_goal",
  "update_goal",
]);

export interface McpToolDescriptor {
  name: string;
  serverId: string;
  remoteName: string;
  label: string;
  status: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  remoteReadOnlyHint: boolean;
  remoteDestructiveHint: boolean;
  serverUpdatedAt: number;
  serverContractSha256: string;
  requestAuthority?: McpAllowedTool["requestAuthority"];
  nativeRenderer?: McpAllowedTool["nativeRenderer"];
}

interface McpToolCallResult {
  text: string;
  trustedAnalyticsCard?: TrustedAnalyticsCard;
  nativeCardIdempotencyKey?: string;
}

interface McpProbedTool {
  name: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  inputSchema: Record<string, unknown>;
}

export interface McpToolService {
  toolDefs(): McpToolDescriptor[];
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  callWithContext(
    name: string,
    args: Record<string, unknown>,
    context: McpHumanCallContext | undefined,
    principalId?: string,
  ): Promise<McpToolCallResult>;
  refresh(): Promise<void>;
  probe(server: McpServer): Promise<McpProbedTool[]>;
  close(): void;
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials") {
    if (!server.tokenAuthMethod || !server.tokenAudienceParameter) {
      throw new Error(`MCP server ${server.id} requires an explicit OAuth token contract`);
    }
    return {
      mode: "client-credentials",
      clientId: server.clientId ?? "",
      clientSecret: server.clientSecret ?? "",
      tokenUrl: server.tokenUrl ?? "",
      audience: server.audience ?? "",
      tokenAuthMethod: server.tokenAuthMethod,
      tokenAudienceParameter: server.tokenAudienceParameter,
      scopes: server.scopes,
    };
  }
  return { mode: "none" };
}

function trustedReadOnly(server: McpServer, allowed: McpAllowedTool, remote: McpRemoteTool): boolean {
  return server.readOnly && allowed.readOnly && remote.readOnlyHint && !remote.destructiveHint;
}

function safetyMatches(allowed: McpAllowedTool, remote: McpRemoteTool): boolean {
  return !allowed.readOnly || (remote.readOnlyHint && !remote.destructiveHint);
}

function exactRemote(tools: McpRemoteTool[], name: string): McpRemoteTool | null {
  const matches = tools.filter((tool) => tool.name === name);
  return matches.length === 1 ? matches[0]! : null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function privateServerExecutionSha256(server: McpServer): string {
  return createHash("sha256").update(canonical(server), "utf8").digest("hex");
}

function publicServerContractSha256(server: McpServer): string {
  if (server.recordVersion && /^[a-f0-9]{64}$/.test(server.recordVersion)) return server.recordVersion;
  const { bearerToken: _bearerToken, clientSecret: _clientSecret, ...safe } = server;
  return createHash("sha256").update(canonical(safe), "utf8").digest("hex");
}

function contractMatches(def: McpToolDescriptor, server: McpServer, allowed: McpAllowedTool, remote: McpRemoteTool) {
  return (
    def.serverUpdatedAt === server.updatedAt &&
    def.serverContractSha256 === publicServerContractSha256(server) &&
    def.label === allowed.label &&
    def.status === allowed.status &&
    safetyMatches(allowed, remote) &&
    def.readOnly === trustedReadOnly(server, allowed, remote) &&
    def.remoteReadOnlyHint === remote.readOnlyHint &&
    def.remoteDestructiveHint === remote.destructiveHint &&
    def.requestAuthority === allowed.requestAuthority &&
    def.nativeRenderer === allowed.nativeRenderer &&
    !!allowed.inputSchema &&
    isDeepStrictEqual(def.inputSchema, allowed.inputSchema) &&
    isDeepStrictEqual(allowed.inputSchema, remote.inputSchema)
  );
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  fetchImpl?: McpFetch;
  resolveHost?: McpResolveHost;
  now?: () => number;
  refreshIntervalMs?: number;
  authoritySigner?: McpAuthoritySigner;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; serverContractSha256: string }>();
  let snapshot: McpToolDescriptor[] = [];
  let closed = false;
  let refreshGeneration = 0;

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
    const contractSha256 = privateServerExecutionSha256(server);
    const cached = clients.get(server.id);
    if (cached?.serverContractSha256 === contractSha256) return cached.client;
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
      now,
    });
    clients.set(server.id, { client, serverContractSha256: contractSha256 });
    return client;
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration;
    const servers = (await opts.servers.list()).filter(
      (server) => server.enabled && server.allowedTools.length > 0 && server.credentialState !== "reentry-required",
    );
    const next: McpToolDescriptor[] = [];
    for (const server of servers) {
      try {
        const discovered = await clientFor(server).listTools();
        if (discovered.length > MAX_TOOLS_PER_SERVER) {
          record("list", server.id, "error: discovered tool count exceeds limit");
          continue;
        }
        const candidate: McpToolDescriptor[] = [];
        let missing = 0;
        for (const allowed of server.allowedTools) {
          const remote = exactRemote(discovered, allowed.name);
          if (
            !remote ||
            !allowed.inputSchema ||
            !safetyMatches(allowed, remote) ||
            !isDeepStrictEqual(allowed.inputSchema, remote.inputSchema)
          ) {
            missing += 1;
            continue;
          }
          candidate.push({
            name: `${server.id}_${remote.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            remoteName: remote.name,
            label: allowed.label,
            status: allowed.status,
            description: allowed.status,
            inputSchema: allowed.inputSchema,
            readOnly: trustedReadOnly(server, allowed, remote),
            remoteReadOnlyHint: remote.readOnlyHint,
            remoteDestructiveHint: remote.destructiveHint,
            serverUpdatedAt: server.updatedAt,
            serverContractSha256: publicServerContractSha256(server),
            ...(allowed.requestAuthority ? { requestAuthority: allowed.requestAuthority } : {}),
            ...(allowed.nativeRenderer ? { nativeRenderer: allowed.nativeRenderer } : {}),
          });
        }
        if (
          new Set(candidate.map((tool) => tool.name)).size !== candidate.length ||
          candidate.some((tool) => RESERVED_TOOL_NAMES.has(tool.name))
        ) {
          record("list", server.id, "error: allowed tool names collide after namespace normalization");
          continue;
        }
        next.push(...candidate);
        const allowedNames = new Set(server.allowedTools.map((tool) => tool.name));
        record(
          "list",
          server.id,
          `ok allowed=${server.allowedTools.length} exposed=${candidate.length} discovered=${discovered.length} hidden=${discovered.filter((tool) => !allowedNames.has(tool.name)).length} missing=${missing}`,
        );
      } catch (error) {
        void error;
        record("list", server.id, "error");
      }
    }
    if (generation !== refreshGeneration) return;
    const activeIds = new Set(servers.map((server) => server.id));
    for (const id of clients.keys()) {
      if (!activeIds.has(id)) clients.delete(id);
    }
    const seen = new Set<string>();
    snapshot = next.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
  }

  const unsubscribe = opts.servers.onChange(() => {
    void refresh();
  });
  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  void refresh();

  async function callWithContext(
    name: string,
    args: Record<string, unknown>,
    context: McpHumanCallContext | undefined,
    principalId?: string,
  ): Promise<McpToolCallResult> {
    const def = snapshot.find((tool) => tool.name === name);
    if (!def) throw new Error(`unknown MCP tool: ${name}`);
    const server = await opts.servers.get(def.serverId);
    if (!server || !server.enabled || server.credentialState === "reentry-required") {
      throw new Error(`MCP server ${def.serverId} is not available`);
    }
    const allowedMatches = server.allowedTools.filter((tool) => tool.name === def.remoteName);
    if (allowedMatches.length !== 1) {
      record("call", `${def.serverId}/${def.remoteName}`, "error: allowlist drift", principalId);
      throw new Error(`MCP tool contract changed: ${def.remoteName}`);
    }
    const allowed = allowedMatches[0]!;
    if (!validateMcpToolArguments(allowed.inputSchema, args)) {
      record("call", `${def.serverId}/${def.remoteName}`, "error: invalid arguments", principalId);
      throw new Error(`MCP tool arguments do not match the pinned contract: ${def.remoteName}`);
    }
    try {
      if (def.nativeRenderer && !def.requestAuthority) {
        throw new Error(`MCP native renderer requires request authority: ${def.remoteName}`);
      }
      if (def.requestAuthority && !opts.authoritySigner) {
        throw new Error(`MCP request authority is unavailable: ${def.remoteName}`);
      }
      const client = clientFor(server);
      const discovered = await client.listTools();
      if (discovered.length > MAX_TOOLS_PER_SERVER) {
        throw new Error(`MCP tool contract changed: ${def.remoteName}`);
      }
      const remote = exactRemote(discovered, def.remoteName);
      if (!remote || !contractMatches(def, server, allowed, remote)) {
        throw new Error(`MCP tool contract changed: ${def.remoteName}`);
      }
      let authority: ReturnType<McpAuthoritySigner["sign"]> | undefined;
      const result = await client.callTool(def.remoteName, args, async () => {
        const current = await opts.servers.get(def.serverId);
        const currentAllowed = current?.allowedTools.filter((tool) => tool.name === def.remoteName) ?? [];
        if (
          !current ||
          !current.enabled ||
          current.credentialState === "reentry-required" ||
          currentAllowed.length !== 1 ||
          !contractMatches(def, current, currentAllowed[0]!, remote)
        ) {
          throw new Error(`MCP tool contract changed: ${def.remoteName}`);
        }
        authority = def.requestAuthority ? opts.authoritySigner!.sign(def.remoteName, args, context) : undefined;
        return authority?.token;
      });
      const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
      const boundedText = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      if (!def.nativeRenderer) {
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        return { text: boundedText };
      }
      if (!authority) throw new Error(`MCP native renderer authority is unavailable: ${def.remoteName}`);
      const delivery = parseAnalyticsNativeDelivery(result.structuredContent, authority.payload);
      if (!delivery) throw new Error(`MCP native renderer result is invalid: ${def.remoteName}`);
      record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
      return {
        text: boundedText,
        trustedAnalyticsCard: opts.authoritySigner!.sealAnalyticsCard(
          delivery.unsignedCard,
          authority.payload,
          context!.deliveryTarget,
        ),
        nativeCardIdempotencyKey: delivery.idempotencyKey,
      };
    } catch (error) {
      record("call", `${def.serverId}/${def.remoteName}`, "error", principalId);
      throw error;
    }
  }

  return {
    toolDefs: () => snapshot,
    async call(name, args, principalId) {
      return (await callWithContext(name, args, undefined, principalId)).text;
    },
    callWithContext,
    refresh,
    async probe(server) {
      const tools = await clientFor(server).listTools();
      if (tools.length > MAX_TOOLS_PER_SERVER) throw new Error("MCP discovered tool count exceeds limit");
      return tools.map((tool) => ({
        name: tool.name,
        readOnlyHint: tool.readOnlyHint,
        destructiveHint: tool.destructiveHint,
        inputSchema: tool.inputSchema,
      }));
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
      clients.clear();
    },
  };
}
