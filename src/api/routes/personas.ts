import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { KeychainError } from "../../credentials/keychain.ts";
import type { PersonaResult } from "../../personas/persona-service.ts";

function principalOf(ctx: ApiCtx, from: "query" | "body"): string | null {
  const raw =
    from === "query"
      ? (ctx.url.searchParams.get("principalId") ?? "")
      : isObj(ctx.body) && typeof ctx.body.principalId === "string"
        ? ctx.body.principalId
        : "";
  const requested = raw.trim();
  if (ctx.capability) {
    if (requested && requested !== ctx.capability.actorId) {
      sendJson(ctx.res, 404, { error: "not_found" });
      return null;
    }
    return ctx.capability.actorId;
  }
  if (!requested) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
    return null;
  }
  return requested;
}

function respond<T>(ctx: ApiCtx, result: PersonaResult<T>, key: string, okStatus = 200): void {
  if (result.status === "ok") return sendJson(ctx.res, okStatus, { [key]: result.value });
  if (result.status === "invalid") return sendJson(ctx.res, 400, { error: "invalid", message: result.message });
  if (result.status === "disabled")
    return sendJson(ctx.res, 404, { error: "personas_disabled", message: "personas are not enabled for you" });
  if (result.status === "forbidden")
    return sendJson(ctx.res, 403, { error: "forbidden", message: "your role on this persona does not allow that" });
  return sendJson(ctx.res, 404, { error: "not_found" });
}

function service(ctx: ApiCtx) {
  if (!ctx.app.personas) sendJson(ctx.res, 503, { error: "personas unavailable" });
  return ctx.app.personas;
}

async function listPersonas(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "query");
  if (!personas || !principalId) return;
  respond(ctx, await personas.list(principalId), "personas");
}

async function getPersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "query");
  if (!personas || !principalId) return;
  respond(ctx, await personas.detail(principalId, ctx.params.id!), "persona");
}

async function createPersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  respond(ctx, await personas.create(principalId, ctx.body), "persona", 201);
}

async function updatePersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  respond(ctx, await personas.update(principalId, ctx.params.id!, ctx.body), "persona");
}

async function deletePersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  respond(ctx, await personas.remove(principalId, ctx.params.id!), "deleted");
}

async function setPersonaAccess(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  const access = isObj(ctx.body) ? ctx.body.access : undefined;
  respond(ctx, await personas.setAccess(principalId, ctx.params.id!, access), "access");
}

function liveOwnerTurn(ctx: ApiCtx): boolean {
  if (!ctx.capability || ctx.capability.liveAuthor === true || ctx.capability.liveActor === true) return true;
  sendJson(ctx.res, 403, {
    error: "forbidden",
    message: "credentials can only be attached or detached on a turn the owner sent themself",
  });
  return false;
}

async function keychainResult<T>(ctx: ApiCtx, fn: () => Promise<PersonaResult<T>>, key: string): Promise<void> {
  try {
    respond(ctx, await fn(), key);
  } catch (e) {
    if (e instanceof KeychainError) return sendJson(ctx.res, e.status, { error: "keychain", message: e.message });
    throw e;
  }
}

async function attachCredential(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId || !liveOwnerTurn(ctx)) return;
  const credentialId = isObj(ctx.body) ? ctx.body.credentialId : undefined;
  await keychainResult(ctx, () => personas.attachCredential(principalId, ctx.params.id!, credentialId), "credential");
}

async function detachCredential(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId || !liveOwnerTurn(ctx)) return;
  await keychainResult(
    ctx,
    () => personas.detachCredential(principalId, ctx.params.id!, ctx.params.grantId!),
    "detached",
  );
}

async function setSessionPersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  const sessionId = ctx.params.id!;
  if (ctx.capability && ctx.capability.sessionId !== sessionId)
    return sendJson(ctx.res, 403, { error: "forbidden", message: "an agent can only set its own session's persona" });
  const viewed = await ctx.app.getSessionForViewer(sessionId, principalId, { tailTurns: 1 });
  if (!viewed) return sendJson(ctx.res, 404, { error: "not_found" });
  const personaId = isObj(ctx.body) ? ctx.body.personaId : undefined;
  if (personaId !== null && (typeof personaId !== "string" || !personaId))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "personaId (string or null) required" });
  respond(ctx, await personas.assign(principalId, viewed.session, personaId), "persona");
}

export const personaRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...withActor("query.principalId", [
    { method: "GET", path: "/v1/personas", auth: "either", handle: listPersonas },
    { method: "GET", path: "/v1/personas/:id", auth: "either", handle: getPersona },
  ]),
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/personas", auth: "either", handle: createPersona },
    { method: "PATCH", path: "/v1/personas/:id", auth: "either", handle: updatePersona },
    { method: "DELETE", path: "/v1/personas/:id", auth: "either", handle: deletePersona },
    { method: "PUT", path: "/v1/personas/:id/access", auth: "either", handle: setPersonaAccess },
    { method: "POST", path: "/v1/personas/:id/credentials", auth: "either", handle: attachCredential },
    { method: "DELETE", path: "/v1/personas/:id/credentials/:grantId", auth: "either", handle: detachCredential },
    { method: "PUT", path: "/v1/sessions/:id/persona", auth: "either", handle: setSessionPersona },
  ]),
];
