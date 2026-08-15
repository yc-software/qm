import { samePerson } from "../../directory/person.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const SCOPE_PATTERN = /^(personal|channel|team|org|group):[^\s]{1,240}$/;

function requestedPrincipal(ctx: ApiCtx): string {
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const requested =
    ctx.url.searchParams.get("principalId") ?? (typeof body.principalId === "string" ? body.principalId : "");
  const authenticated = ctx.capability?.actorId ?? ctx.actor?.p ?? "";
  if (authenticated && requested && !samePerson(authenticated, requested)) return "";
  return authenticated || requested;
}

function requireService(ctx: ApiCtx) {
  if (!ctx.deps.pipedream) {
    sendJson(ctx.res, 501, { error: "not_configured", message: "integration service is unavailable" });
    return null;
  }
  return ctx.deps.pipedream;
}

function requirePrincipal(ctx: ApiCtx): string | null {
  const principalId = requestedPrincipal(ctx);
  if (!principalId) {
    sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId is required and must match the signed-in user",
    });
    return null;
  }
  return principalId;
}

async function status(ctx: ApiCtx): Promise<void> {
  const service = requireService(ctx);
  if (!service) return;
  return sendJson(ctx.res, 200, { configured: service.configured(), provider: "pipedream" });
}

async function connect(ctx: ApiCtx): Promise<void> {
  const service = requireService(ctx);
  const principalId = requirePrincipal(ctx);
  if (!service || !principalId) return;
  const returnUrl = ctx.deps.portalUrl
    ? `${ctx.deps.portalUrl.replace(/\/$/, "")}/integrations?connected=1`
    : undefined;
  try {
    return sendJson(ctx.res, 200, await service.createConnectLink(principalId, returnUrl));
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "provider_error", message: errMessage(error) });
  }
}

async function accounts(ctx: ApiCtx): Promise<void> {
  const service = requireService(ctx);
  const principalId = requirePrincipal(ctx);
  if (!service || !principalId) return;
  try {
    return sendJson(ctx.res, 200, { accounts: await service.listOwned(principalId) });
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "provider_error", message: errMessage(error) });
  }
}

async function updateAccount(ctx: ApiCtx): Promise<void> {
  const service = requireService(ctx);
  const principalId = requirePrincipal(ctx);
  if (!service || !principalId) return;
  const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
  const access: "read" | "read-write" | undefined =
    body.access === "read" || body.access === "read-write" ? body.access : undefined;
  const scopes = Array.isArray(body.scopes)
    ? [
        ...new Set(
          body.scopes.filter((scope): scope is string => typeof scope === "string" && SCOPE_PATTERN.test(scope)),
        ),
      ].slice(0, 32)
    : undefined;
  if (!access && !scopes) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "access or scopes is required" });
  }
  if (scopes) {
    for (const scope of scopes) {
      if (!(await ctx.app.belongsToScope(principalId, scope))) {
        return sendJson(ctx.res, 403, { error: "forbidden", message: `not a member of ${scope}` });
      }
    }
  }
  const patch = { ...(access ? { access } : {}), ...(scopes ? { scopes } : {}) };
  const account = await service.updateOwned(principalId, ctx.params.id ?? "", patch);
  return account
    ? sendJson(ctx.res, 200, { account })
    : sendJson(ctx.res, 404, { error: "not_found", message: "connected account not found" });
}

async function deleteAccount(ctx: ApiCtx): Promise<void> {
  const service = requireService(ctx);
  const principalId = requirePrincipal(ctx);
  if (!service || !principalId) return;
  try {
    const removed = await service.deleteOwned(principalId, ctx.params.id ?? "");
    return removed
      ? sendJson(ctx.res, 200, { ok: true })
      : sendJson(ctx.res, 404, { error: "not_found", message: "connected account not found" });
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "provider_error", message: errMessage(error) });
  }
}

export const integrationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/integrations/status", auth: "source", handle: status },
  { method: "POST", path: "/v1/integrations/connect", auth: "source", handle: connect },
  { method: "GET", path: "/v1/integrations/accounts", auth: "source", handle: accounts },
  { method: "PUT", path: "/v1/integrations/accounts/:id", auth: "source", handle: updateAccount },
  { method: "DELETE", path: "/v1/integrations/accounts/:id", auth: "source", handle: deleteAccount },
];
