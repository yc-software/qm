import { isDeepStrictEqual } from "node:util";
import { validateMcpHttpsUrl } from "../../../mcp/mcp-client.ts";
import {
  isValidMcpServerId,
  parseMcpAllowedTools,
  type McpServer,
  type McpServerAuthMode,
  type McpTokenAudienceParameter,
  type McpTokenAuthMethod,
} from "../../../mcp/mcp-server-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials"];
const SCOPE_PATTERN = /^[A-Za-z0-9:._/-]{1,128}$/;
const TOKEN_AUTH_METHODS: McpTokenAuthMethod[] = ["client_secret_basic", "client_secret_post"];
const TOKEN_AUDIENCE_PARAMETERS: McpTokenAudienceParameter[] = ["audience", "resource"];
const PUT_FIELDS = new Set([
  "name",
  "url",
  "auth",
  "bearerToken",
  "clientId",
  "clientSecret",
  "tokenUrl",
  "audience",
  "tokenAuthMethod",
  "tokenAudienceParameter",
  "scopes",
  "allowedTools",
  "readOnly",
  "enabled",
]);

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

function redact(server: McpServer) {
  const { bearerToken, clientSecret, recordVersion, ...rest } = server;
  void recordVersion;
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret };
}

function bounded(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function scopes(value: unknown, existing: string[] | undefined): string[] | null {
  const source = value === undefined ? (existing ?? []) : value;
  if (
    !Array.isArray(source) ||
    source.length > 64 ||
    source.some((scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) ||
    new Set(source).size !== source.length
  ) {
    return null;
  }
  return [...source];
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
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, label, status, description, readOnly }) => ({
      name,
      serverId,
      label,
      status,
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
  if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "request body must be an object" });
  }
  const body = ctx.body as Partial<McpServer>;
  if (Object.keys(body).some((field) => !PUT_FIELDS.has(field))) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "request body contains unknown fields" });
  }
  for (const [field, maximum] of [
    ["name", 80],
    ["url", 2_048],
    ["bearerToken", 16_384],
    ["clientId", 512],
    ["clientSecret", 16_384],
    ["tokenUrl", 2_048],
    ["audience", 2_048],
  ] as const) {
    if (Object.hasOwn(body, field) && !bounded(body[field], maximum)) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: `${field} is invalid` });
    }
  }
  if (
    (body.readOnly !== undefined && typeof body.readOnly !== "boolean") ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean")
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "readOnly and enabled must be booleans" });
  }
  if (body.scopes !== undefined && scopes(body.scopes, undefined) === null) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "scopes are invalid" });
  }
  if (body.tokenAuthMethod !== undefined && !TOKEN_AUTH_METHODS.includes(body.tokenAuthMethod)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "tokenAuthMethod is invalid" });
  }
  if (body.tokenAudienceParameter !== undefined && !TOKEN_AUDIENCE_PARAMETERS.includes(body.tokenAudienceParameter)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "tokenAudienceParameter is invalid" });
  }
  if (Object.hasOwn(body, "auth") && !AUTH_MODES.includes(body.auth as McpServerAuthMode)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  if (body.enabled === false) {
    if (Object.keys(body).length !== 1) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: "disable requests must contain only enabled" });
    }
    const disabled = await ctx.deps.mcpServers.disable(id, authorized.id, Date.now());
    if (!disabled) return sendJson(ctx.res, 404, { error: "not_found" });
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "mcp-servers.update",
      resource: id,
      scopeLabel: orgScope(ctx.deps),
    });
    return sendJson(ctx.res, 200, { ok: true, server: redact(disabled) });
  }
  const url = typeof body.url === "string" ? body.url.trim() : (existing?.url ?? "");
  try {
    validateMcpHttpsUrl(url);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
  }
  const auth = (body.auth ?? existing?.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  let allowedTools;
  try {
    allowedTools = parseMcpAllowedTools(
      Object.hasOwn(body, "allowedTools") ? body.allowedTools : existing?.allowedTools,
    );
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
  }
  const readOnly = body.readOnly === undefined ? (existing?.readOnly ?? false) : body.readOnly === true;
  if (readOnly && allowedTools.some((tool) => !tool.readOnly)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "a read-only server contract requires every allowed tool to be read-only",
    });
  }
  const sameAuth = existing?.auth === auth;
  const clientId =
    auth === "client-credentials"
      ? (bounded(body.clientId, 512) ?? (sameAuth ? existing?.clientId : undefined))
      : undefined;
  const tokenUrl =
    auth === "client-credentials"
      ? (bounded(body.tokenUrl, 2_048) ?? (sameAuth ? existing?.tokenUrl : undefined))
      : undefined;
  const audience =
    auth === "client-credentials"
      ? (bounded(body.audience, 2_048) ?? (sameAuth ? existing?.audience : undefined))
      : undefined;
  const tokenAuthMethod =
    auth === "client-credentials"
      ? ((body.tokenAuthMethod ?? (sameAuth ? existing?.tokenAuthMethod : undefined)) as McpTokenAuthMethod | undefined)
      : undefined;
  const tokenAudienceParameter =
    auth === "client-credentials"
      ? ((body.tokenAudienceParameter ?? (sameAuth ? existing?.tokenAudienceParameter : undefined)) as
          McpTokenAudienceParameter | undefined)
      : undefined;
  const oauthScopes = auth === "client-credentials" ? scopes(body.scopes, sameAuth ? existing?.scopes : undefined) : [];
  if (tokenUrl) {
    try {
      validateMcpHttpsUrl(tokenUrl, "MCP token URL");
    } catch (error) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: (error as Error).message });
    }
  }
  const bearerToken =
    auth === "bearer"
      ? (bounded(body.bearerToken, 16_384) ?? (sameAuth && existing?.url === url ? existing.bearerToken : undefined))
      : undefined;
  const clientContractUnchanged =
    sameAuth &&
    existing?.url === url &&
    existing.clientId === clientId &&
    existing.tokenUrl === tokenUrl &&
    existing.audience === audience &&
    existing.tokenAuthMethod === tokenAuthMethod &&
    existing.tokenAudienceParameter === tokenAudienceParameter &&
    isDeepStrictEqual(existing.scopes, oauthScopes);
  const clientSecret =
    auth === "client-credentials"
      ? (bounded(body.clientSecret, 16_384) ?? (clientContractUnchanged ? existing?.clientSecret : undefined))
      : undefined;
  if (auth === "bearer" && !bearerToken) {
    return sendJson(ctx.res, 400, { error: "credential_reentry_required", message: "bearerToken must be re-entered" });
  }
  const explicitScopesRequired = !sameAuth || existing?.credentialState === "reentry-required";
  if (
    auth === "client-credentials" &&
    (!clientId ||
      !clientSecret ||
      !tokenUrl ||
      !audience ||
      !tokenAuthMethod ||
      !TOKEN_AUTH_METHODS.includes(tokenAuthMethod) ||
      !tokenAudienceParameter ||
      !TOKEN_AUDIENCE_PARAMETERS.includes(tokenAudienceParameter) ||
      !oauthScopes ||
      (explicitScopesRequired && body.scopes === undefined))
  ) {
    return sendJson(ctx.res, 400, {
      error: "credential_reentry_required",
      message:
        "clientId, clientSecret, tokenUrl, audience, tokenAuthMethod, tokenAudienceParameter, and scopes must be supplied",
    });
  }
  const server: McpServer = {
    id,
    name: bounded(body.name, 80) ?? existing?.name ?? id,
    url,
    auth,
    ...(bearerToken ? { bearerToken } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
    ...(audience ? { audience } : {}),
    ...(tokenAuthMethod ? { tokenAuthMethod } : {}),
    ...(tokenAudienceParameter ? { tokenAudienceParameter } : {}),
    scopes: oauthScopes ?? [],
    allowedTools,
    readOnly,
    enabled: body.enabled === undefined ? (existing?.enabled ?? true) : body.enabled === true,
    credentialState: auth === "none" ? "none" : "ready",
    updatedAt: Date.now(),
    updatedBy: authorized.id,
  };
  if (!ctx.deps.mcpToolService) return sendJson(ctx.res, 503, { error: "unavailable" });
  let discovered;
  try {
    discovered = await ctx.deps.mcpToolService.probe(server);
  } catch (error) {
    return sendJson(ctx.res, 400, {
      error: "unreachable",
      message: `tools/list failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const pinnedAllowedTools = [];
  for (const allowed of allowedTools) {
    const matches = discovered.filter((tool) => tool.name === allowed.name);
    if (matches.length !== 1) {
      return sendJson(ctx.res, 400, {
        error: "contract_mismatch",
        message: `allowed tool ${allowed.name} was not discovered exactly once`,
      });
    }
    if (allowed.readOnly && (!matches[0]!.readOnlyHint || matches[0]!.destructiveHint)) {
      return sendJson(ctx.res, 400, {
        error: "contract_mismatch",
        message: `allowed tool ${allowed.name} does not advertise a non-destructive read-only contract`,
      });
    }
    if (!isDeepStrictEqual(allowed.inputSchema, matches[0]!.inputSchema)) {
      return sendJson(ctx.res, 400, {
        error: "contract_mismatch",
        message: `allowed tool ${allowed.name} input schema does not match discovery`,
      });
    }
    pinnedAllowedTools.push(allowed);
  }
  server.allowedTools = pinnedAllowedTools;
  if (!(await ctx.deps.mcpServers.putIfCurrent(server, existing?.recordVersion ?? null))) {
    return sendJson(ctx.res, 409, {
      error: "conflict",
      message: "MCP server changed while its remote contract was being verified; retry with current state",
    });
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  const saved = await ctx.deps.mcpServers.get(id);
  return sendJson(ctx.res, 200, { ok: true, server: redact(saved ?? server), discoveredTools: discovered });
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
