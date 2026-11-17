import { errMessage } from "../../util/errors.ts";
import { EnvironmentShareDenied } from "../../environments/environment-store.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function listEnvironments(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "environments require an agent capability token" });
  const rows = await app.listEnvironments();
  return sendJson(res, 200, {
    environments: rows.map(({ environment, attachments }) => ({
      id: environment.id,
      name: environment.name,
      ownerActorId: environment.ownerActorId,
      attachedScopes: attachments.map((a) => a.scopeId),
    })),
  });
}

async function createEnvironment(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "environments require an agent capability token" });
  const name = isObj(body) && typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return sendJson(res, 400, { error: "bad_request", message: "name (string) required" });
  try {
    const env = await app.createEnvironment({ scopeId: capability.scopeId, name, actorId: capability.actorId });
    return sendJson(res, 200, { environment: { id: env.id, name: env.name, ownerActorId: env.ownerActorId } });
  } catch (e) {
    return sendJson(res, 400, { error: "environment_create_failed", message: errMessage(e) });
  }
}

async function attachEnvironment(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "environments require an agent capability token" });
  const name = isObj(body) && typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return sendJson(res, 400, { error: "bad_request", message: "name (string) required" });
  const env = await app.resolveEnvironmentByName(name);
  if (!env) return sendJson(res, 404, { error: "environment_not_found", message: `no environment named "${name}"` });
  try {
    await app.attachScope({ scopeId: capability.scopeId, environmentId: env.id, actorId: capability.actorId });
    return sendJson(res, 200, { ok: true, environment: { id: env.id, name: env.name } });
  } catch (e) {
    if (e instanceof EnvironmentShareDenied) {
      return sendJson(res, 403, {
        error: "owner_mediation_required",
        message: `environment "${name}" belongs to ${e.ownerScopeId}. Ask someone in that conversation to attach this one to it — only a current member of its owning conversation can share it.`,
        ownerScopeId: e.ownerScopeId,
      });
    }
    return sendJson(res, 400, { error: "environment_attach_failed", message: errMessage(e) });
  }
}

export const environmentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/environments", auth: "either", handle: listEnvironments },
  { method: "POST", path: "/v1/environments", auth: "either", handle: createEnvironment },
  { method: "POST", path: "/v1/environments/attach", auth: "either", handle: attachEnvironment },
];
