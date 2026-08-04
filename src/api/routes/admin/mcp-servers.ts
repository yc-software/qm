// Admin CRUD for registered MCP servers.
//
// Registration is deliberately admin-only: a registered server is an outbound
// HTTP destination every scope's agents can call, so it is governed like a
// model-provider credential, not like a personal connector.

import { isValidMcpServerId, type McpServer, type McpServerAuthMode } from "../../../mcp/mcp-server-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials"];

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

function redact(server: McpServer): Omit<McpServer, "bearerToken" | "clientSecret"> & {
  hasBearerToken: boolean;
  hasClientSecret: boolean;
} {
  const { bearerToken, clientSecret, ...rest } = server;
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret };
}

export async function getMcpServers(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.read",
    resource: "mcp-servers",
    scopeLabel: orgScope(ctx.deps),
  });
  const servers = await ctx.deps.mcpServers.list();
  return sendJson(ctx.res, 200, {
    servers: servers.map(redact),
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, description, readOnly }) => ({
      name,
      serverId,
      description,
      readOnly,
    })),
  });
}

export async function putMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter",
    });
  }
  const b = ctx.body as Partial<McpServer> & { validate?: boolean };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be a valid URL" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be http(s)" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "url must not carry credentials, query, or fragment",
    });
  }
  const auth = (b.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    ...(auth === "bearer"
      ? { bearerToken: typeof b.bearerToken === "string" && b.bearerToken ? b.bearerToken : existing?.bearerToken }
      : {}),
    ...(auth === "client-credentials"
      ? {
          clientId: typeof b.clientId === "string" && b.clientId ? b.clientId : existing?.clientId,
          clientSecret: typeof b.clientSecret === "string" && b.clientSecret ? b.clientSecret : existing?.clientSecret,
        }
      : {}),
    readOnly: b.readOnly !== false,
    enabled: b.enabled !== false,
    updatedAt: Date.now(),
    updatedBy: authorized.id,
  };
  if (auth === "bearer" && !server.bearerToken) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "bearer auth requires bearerToken" });
  }
  if (auth === "client-credentials" && (!server.clientId || !server.clientSecret)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "client-credentials auth requires clientId and clientSecret",
    });
  }
  let toolNames: string[] | undefined;
  if (b.validate !== false && ctx.deps.mcpToolService) {
    try {
      toolNames = await ctx.deps.mcpToolService.probe(server);
    } catch (e) {
      return sendJson(ctx.res, 400, {
        error: "unreachable",
        message: `tools/list against ${parsed.host} failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  await ctx.deps.mcpServers.put(server);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, server: redact(server), ...(toolNames ? { tools: toolNames } : {}) });
}

export async function deleteMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!(await ctx.deps.mcpServers.get(id))) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.mcpServers.delete(id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
