// Admin CRUD for registered MCP servers.
//
// Registration is deliberately admin-only: a registered server is an outbound
// HTTP destination every scope's agents can call, so it is governed like a
// model-provider credential, not like a personal connector.

import { isValidMcpServerId, type McpServer, type McpServerAuthMode } from "../../../mcp/mcp-server-store.ts";
import { PROVIDERS } from "../../../connectors/oauth.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials", "oauth-user"];

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseScopes(v: unknown): string[] | undefined {
  const raw: unknown[] | undefined = typeof v === "string" ? v.split(/\s+/) : undefined;
  return (raw ?? (Array.isArray(v) ? (v as unknown[]) : undefined))
    ?.filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim());
}

async function discoverOAuth(issuer: string): Promise<{ authorize?: string; token?: string }> {
  const base = issuer.replace(/\/+$/, "");
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const r = await fetch(`${base}${path}`, { redirect: "error" });
      if (!r.ok) continue;
      const meta = (await r.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown };
      return { authorize: httpsUrl(meta.authorization_endpoint), token: httpsUrl(meta.token_endpoint) };
    } catch {
      continue;
    }
  }
  return {};
}

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
  const oauthUser = auth === "oauth-user";
  if (oauthUser && PROVIDERS[id] && existing?.auth !== "oauth-user") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `id ${id} is reserved by a built-in connector` });
  }
  const credentialScope = oauthUser ? "per-user" : (b.credentialScope ?? existing?.credentialScope ?? "shared");
  if (credentialScope !== "shared" && credentialScope !== "per-user") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "credentialScope must be shared or per-user" });
  }
  const credentialHost = b.credentialHost ?? existing?.credentialHost ?? (oauthUser ? parsed.hostname : undefined);
  if (
    oauthUser &&
    typeof credentialHost === "string" &&
    Object.entries(PROVIDERS).some(
      ([name, p]) => name !== id && p.hosts.some((h) => credentialHost === h || credentialHost.endsWith(`.${h}`)),
    )
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "credentialHost is already used by another connector",
    });
  }
  let oauthAuthorizeUrl = httpsUrl(b.oauthAuthorizeUrl) ?? (oauthUser ? existing?.oauthAuthorizeUrl : undefined);
  let oauthTokenUrl = httpsUrl(b.oauthTokenUrl) ?? (oauthUser ? existing?.oauthTokenUrl : undefined);
  const issuer = httpsUrl((b as { oauthIssuer?: unknown }).oauthIssuer);
  if (oauthUser && issuer && (!oauthAuthorizeUrl || !oauthTokenUrl)) {
    const found = await discoverOAuth(issuer);
    oauthAuthorizeUrl ??= found.authorize;
    oauthTokenUrl ??= found.token;
  }
  const credentialAccountType = b.credentialAccountType ?? existing?.credentialAccountType ?? "default";
  if (!["default", "personal", "company"].includes(credentialAccountType)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "credentialAccountType must be default, personal, or company",
    });
  }
  if (
    credentialScope === "per-user" &&
    (typeof credentialHost !== "string" ||
      !credentialHost ||
      credentialHost !== credentialHost.trim() ||
      credentialHost.length > 253 ||
      /[\s/\\?#@]/.test(credentialHost))
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "per-user credentials require a credentialHost" });
  }
  if (
    credentialScope === "per-user" &&
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "per-user credentials require HTTPS (except loopback)",
    });
  }
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    credentialScope,
    ...(credentialScope === "per-user" ? { credentialHost, credentialAccountType } : {}),
    ...(auth === "bearer"
      ? { bearerToken: typeof b.bearerToken === "string" && b.bearerToken ? b.bearerToken : existing?.bearerToken }
      : {}),
    ...(oauthUser
      ? {
          clientId: typeof b.clientId === "string" && b.clientId ? b.clientId.trim() : existing?.clientId,
          oauthAuthorizeUrl,
          oauthTokenUrl,
          oauthScopes: parseScopes(b.oauthScopes) ?? existing?.oauthScopes ?? [],
        }
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
  if (oauthUser && (!server.clientId || !server.oauthAuthorizeUrl || !server.oauthTokenUrl)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message:
        "oauth-user auth requires clientId plus HTTPS oauthAuthorizeUrl and oauthTokenUrl (or an oauthIssuer to discover them)",
    });
  }
  let toolNames: string[] | undefined;
  if (b.validate !== false && !oauthUser && ctx.deps.mcpToolService) {
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
