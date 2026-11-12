import { sendJson } from "../http.ts";
import { swallowAs } from "../../util/errors.ts";
import { isObj } from "./shared.ts";
import { personAtKeyboard } from "../artifact-share.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { KeychainError } from "../../credentials/keychain.ts";
import type { PersonaResult } from "../../personas/persona-service.ts";
import type { Cron } from "../../triggers/types.ts";
import { memoryRecallLabels } from "../../memory/recall-labels.ts";

function principalOf(ctx: ApiCtx, from: "query" | "body"): string | null {
  const body = isObj(ctx.body) && typeof ctx.body.principalId === "string" ? ctx.body.principalId : "";
  const raw = from === "query" ? (ctx.url.searchParams.get("principalId") ?? "") : body;
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

function respond<T>(ctx: ApiCtx, result: PersonaResult<T>, key: string | null, okStatus = 200): void {
  if (result.status === "ok") return sendJson(ctx.res, okStatus, key === null ? result.value : { [key]: result.value });
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
  const result = await personas.detail(principalId, ctx.params.id!);
  if (result.status !== "ok") return respond(ctx, result, "persona");
  const access = await Promise.all(
    result.value.access.map(async (grant) => ({ ...grant, label: await granteeLabel(ctx, grant.scopeId) })),
  );
  const home = `persona:${result.value.id}`;
  const skills = (await ctx.app.listVisibleSkills(principalId))
    .flatMap((row) => (row.skill?.scopeId === home ? [row.skill] : []))
    .map((skill) => ({ id: skill.id, name: skill.manifest.name, description: skill.manifest.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const crons = await personaCrons(ctx, principalId, result.value.id);
  respond(ctx, { status: "ok", value: { ...result.value, access, skills, crons } }, "persona");
}

async function personaCrons(ctx: ApiCtx, principalId: string, personaId: string) {
  const { owned, visible } = await ctx.app.listCronsForViewer(principalId);
  const crons = [...new Map([...owned, ...visible].map((c) => [c.id, c])).values()].filter((c) => !c.archived);
  const refsOf = (c: Cron) => [...new Set([c.destination?.target, c.sessionRef])].filter((ref) => ref !== undefined);
  const personaThreads =
    (await ctx.deps.sessions?.threadsWithPersona(personaId, [...new Set(crons.flatMap(refsOf))])) ?? new Set();
  return crons
    .filter((c) => refsOf(c).some((ref) => personaThreads.has(ref)))
    .map(({ id, title, action, message, schedule, enabled }) => ({ id, title, action, message, schedule, enabled }));
}

async function granteeLabel(ctx: ApiCtx, scopeId: string): Promise<string | undefined> {
  const [kind, ...rest] = scopeId.split(":");
  const ref = rest.join(":");
  if (kind === "channel")
    return ctx.app.channelName(ref).catch(swallowAs(`persona grantee label ${scopeId}`, undefined));
  if (kind === "group") {
    const label = (await memoryRecallLabels([scopeId], ctx.deps.directory)).get(scopeId);
    return label === scopeId ? undefined : label;
  }
  if (kind === "personal")
    return (
      (await ctx.app.directoryMember(ref).catch(swallowAs(`persona grantee label ${scopeId}`, null)))?.displayName ||
      undefined
    );
  return undefined;
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

const VERSION_PAGE = 20;

function positiveInt(value: string | null | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

async function listPersonaVersions(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "query");
  if (!personas || !principalId) return;
  const before = ctx.url.searchParams.get("before");
  if (before !== null && positiveInt(before) === undefined)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "before must be a positive integer" });
  const limit = ctx.url.searchParams.get("limit");
  if (limit !== null && positiveInt(limit) === undefined)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "limit must be a positive integer" });
  respond(
    ctx,
    await personas.versions(principalId, ctx.params.id!, {
      ...(before ? { before: Number(before) } : {}),
      limit: limit ? Number(limit) : VERSION_PAGE,
      ...(ctx.url.searchParams.get("full") === "1" ? { full: true } : {}),
    }),
    null,
  );
}

async function restorePersonaVersion(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  const version = positiveInt(ctx.params.version);
  if (version === undefined)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "version must be a positive integer" });
  respond(ctx, await personas.restore(principalId, ctx.params.id!, version), "persona");
}

async function setPersonaAccess(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId) return;
  const access = isObj(ctx.body) ? ctx.body.access : undefined;
  respond(ctx, await personas.setAccess(principalId, ctx.params.id!, access), "access");
}

function liveOwnerTurn(ctx: ApiCtx): boolean {
  if (!ctx.capability || personAtKeyboard(ctx.capability)) return true;
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
  const viewed = await ctx.app.getSessionForViewer(sessionId, ctx.capability ?? { actorId: principalId }, {
    tailTurns: 1,
  });
  if (!viewed) return sendJson(ctx.res, 404, { error: "not_found" });
  const personaId = isObj(ctx.body) ? ctx.body.personaId : undefined;
  if (personaId !== null && (typeof personaId !== "string" || !personaId))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "personaId (string or null) required" });
  respond(ctx, await personas.assign(principalId, viewed.session, personaId), "persona");
}

export const personaRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...withActor("query.principalId", [
    { method: "GET", path: "/v1/personas", browser: true, auth: "either", handle: listPersonas },
    { method: "GET", path: "/v1/personas/:id", browser: true, auth: "either", handle: getPersona },
    { method: "GET", path: "/v1/personas/:id/versions", browser: true, auth: "either", handle: listPersonaVersions },
  ]),
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/personas", browser: true, auth: "either", handle: createPersona },
    { method: "PATCH", path: "/v1/personas/:id", browser: true, auth: "either", handle: updatePersona },
    { method: "DELETE", path: "/v1/personas/:id", browser: true, auth: "either", handle: deletePersona },
    {
      method: "POST",
      path: "/v1/personas/:id/versions/:version/restore",
      browser: true,
      auth: "either",
      handle: restorePersonaVersion,
    },
    { method: "PUT", path: "/v1/personas/:id/access", browser: true, auth: "either", handle: setPersonaAccess },
    { method: "POST", path: "/v1/personas/:id/credentials", browser: true, auth: "either", handle: attachCredential },
    {
      method: "DELETE",
      path: "/v1/personas/:id/credentials/:grantId",
      browser: true,
      auth: "either",
      handle: detachCredential,
    },
    { method: "PUT", path: "/v1/sessions/:id/persona", browser: true, auth: "either", handle: setSessionPersona },
  ]),
];
