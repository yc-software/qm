import { sendJson } from "../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
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
  if (!requested || requested === own) return { scope: own, actorId: capability.actorId };
  const actor = await authorizeAdmin(ctx, requested);
  if (!actor) return null;
  return { scope: requested, actorId: capability.actorId };
}

function requestedScope(ctx: ApiCtx): string {
  const body = isObj(ctx.body) ? ctx.body : {};
  const fromBody = typeof body.scope === "string" ? body.scope : "";
  return fromBody || ctx.url.searchParams.get("scope") || "";
}

async function startConnect(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, { error: "not_supported", message: "procedural memory is off in this deployment" });
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
    return sendJson(res, 404, { error: "not_supported", message: "procedural memory is off in this deployment" });
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
    return sendJson(res, 404, { error: "not_supported", message: "procedural memory is off in this deployment" });
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

async function listAccounts(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.memorableAccounts) {
    return sendJson(res, 404, { error: "not_supported", message: "procedural memory is off in this deployment" });
  }
  const actor = await authorizeAdmin(ctx, orgScope());
  if (!actor) return;
  return sendJson(res, 200, { accounts: await deps.memorableAccounts.connected() });
}

export const memorableRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/memorable/connect", auth: "either", handle: startConnect },
  { method: "GET", path: "/v1/memorable/connect", auth: "either", handle: connectStatus },
  { method: "DELETE", path: "/v1/memorable/connect", auth: "either", handle: disconnect },
  { method: "GET", path: "/v1/memorable/accounts", auth: "either", handle: listAccounts },
];
