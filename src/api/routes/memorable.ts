import { sendJson } from "../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { parseConsentMode, setConsent } from "../../memorable/consent.ts";
import { personalScope } from "../../types.ts";
import type { ApiCtx, Route } from "./route.ts";

type Resolved = { scope: string; actorId: string } | null;

async function resolveScope(ctx: ApiCtx, requested: string): Promise<Resolved> {
  const { res, capability } = ctx;
  if (!capability) {
    sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
    return null;
  }
  const own = personalScope(capability.actorId);
  if (requested && requested !== own) {
    sendJson(res, 400, {
      error: "bad_request",
      message:
        "a Memorable sign-in can only be started for yourself: whoever opens the URL is whoever the key belongs to, so binding it to another scope would file their account under someone else's name. Ask that person to run it from their own session.",
    });
    return null;
  }
  return { scope: own, actorId: capability.actorId };
}

function requestedScope(ctx: ApiCtx): string {
  const body = isObj(ctx.body) ? ctx.body : {};
  const fromBody = typeof body.scope === "string" ? body.scope : "";
  return fromBody || ctx.url.searchParams.get("scope") || "";
}

async function startConnect(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, {
      error: "not_supported",
      message:
        "per-scope Memorable accounts are unavailable: the integration is off, or CONNECTOR_SECRET_KEY is unset so there is nothing to encrypt a stored key with",
    });
  }
  const resolved = await resolveScope(ctx, requestedScope(ctx));
  if (!resolved) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const result = await deps.memorableAccounts.start(resolved.scope, { force: body.force === true });
  if (result.status === "unavailable") return sendJson(res, 503, result);
  audit(deps, {
    principalId: resolved.actorId,
    action: "memorable.connect.start",
    resource: resolved.scope,
    scopeLabel: resolved.scope,
  });
  return sendJson(res, 200, { scope: resolved.scope, ...result });
}

async function connectStatus(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, {
      error: "not_supported",
      message:
        "per-scope Memorable accounts are unavailable: the integration is off, or CONNECTOR_SECRET_KEY is unset so there is nothing to encrypt a stored key with",
    });
  }
  const resolved = await resolveScope(ctx, requestedScope(ctx));
  if (!resolved) return;
  const result = await deps.memorableAccounts.poll(resolved.scope);
  if (result.status === "unavailable") return sendJson(res, 503, result);
  if (result.status === "connected") {
    audit(deps, {
      principalId: resolved.actorId,
      action: "memorable.connect.complete",
      resource: result.orgId,
      scopeLabel: resolved.scope,
    });
  }
  return sendJson(res, 200, { scope: resolved.scope, ...result });
}

async function disconnect(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, {
      error: "not_supported",
      message:
        "per-scope Memorable accounts are unavailable: the integration is off, or CONNECTOR_SECRET_KEY is unset so there is nothing to encrypt a stored key with",
    });
  }
  const resolved = await resolveScope(ctx, requestedScope(ctx));
  if (!resolved) return;
  const removed = await deps.memorableAccounts.disconnect(resolved.scope);
  audit(deps, {
    principalId: resolved.actorId,
    action: "memorable.disconnect",
    resource: resolved.scope,
    scopeLabel: resolved.scope,
  });
  return sendJson(res, 200, { scope: resolved.scope, disconnected: removed });
}

async function consent(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts || !deps.memorableBin || !deps.memorableProcessEnv) {
    return sendJson(res, 404, {
      error: "not_supported",
      message:
        "per-scope Memorable accounts are unavailable: the integration is off, or CONNECTOR_SECRET_KEY is unset so there is nothing to encrypt a stored key with",
    });
  }
  const body = isObj(ctx.body) ? ctx.body : {};
  const mode = parseConsentMode(body.mode);
  if (!mode) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'mode must be "read-write" (capture on), "read-only" (recall only), or "deny"',
    });
  }
  const resolved = await resolveScope(ctx, requestedScope(ctx));
  if (!resolved) return;
  const apiKey = await deps.memorableAccounts.keyFor(resolved.scope).catch(() => null);
  const result = await setConsent(deps.memorableBin, resolved.scope, mode, {
    env: deps.memorableProcessEnv,
    ...(apiKey ? { apiKey } : {}),
  });
  audit(deps, {
    principalId: resolved.actorId,
    action: "memorable.consent",
    resource: mode,
    scopeLabel: resolved.scope,
  });
  return sendJson(res, result.ok ? 200 : 502, { scope: resolved.scope, ...result });
}

async function listAccounts(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, {
      error: "not_supported",
      message:
        "per-scope Memorable accounts are unavailable: the integration is off, or CONNECTOR_SECRET_KEY is unset so there is nothing to encrypt a stored key with",
    });
  }
  const actor = await authorizeAdmin(ctx, orgScope());
  if (!actor) return;
  return sendJson(res, 200, { accounts: await deps.memorableAccounts.connected() });
}

export const memorableRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/memorable/connect", auth: "either", handle: startConnect },
  { method: "GET", path: "/v1/memorable/connect", auth: "either", handle: connectStatus },
  { method: "DELETE", path: "/v1/memorable/connect", auth: "either", handle: disconnect },
  { method: "POST", path: "/v1/memorable/consent", auth: "either", handle: consent },
  { method: "GET", path: "/v1/memorable/accounts", auth: "either", handle: listAccounts },
];
