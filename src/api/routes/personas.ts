import { sendJson } from "../http.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { audit, isObj, isOrgAdmin, requirePersonAuthority } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { KeychainError } from "../../credentials/keychain.ts";
import type { PersonaResult } from "../../personas/persona-service.ts";
import type { Cron } from "../../triggers/types.ts";
import { isOwnScopeBotWork } from "../../resolution/context-filter.ts";
import { sessionVisibleTo } from "../../sessions/session-rows.ts";
import { scopeId } from "../../types.ts";
import { actionApproved } from "../action-approval.ts";

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
  const skills = (await ctx.app.listVisibleSkills(principalId, isOwnScopeBotWork(ctx.capability)))
    .flatMap((row) => row.shadowed.concat(row.skill ?? []))
    .filter((skill) => skill.scopeId === home)
    .map((skill) => ({ id: skill.id, name: skill.manifest.name, description: skill.manifest.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pinned = new Set(result.value.access.filter((grant) => grant.pinned).map((grant) => grant.scopeId));
  const crons = await personaCrons(ctx, principalId, result.value.id, pinned);
  respond(ctx, { status: "ok", value: { ...result.value, access, skills, crons } }, "persona");
}

async function personaCrons(ctx: ApiCtx, principalId: string, personaId: string, pinned: Set<string>) {
  const { owned, visible } = await ctx.app.listCronsForViewer(principalId);
  const crons = [...new Map([...owned, ...visible].map((c) => [c.id, c])).values()].filter((c) => !c.archived);
  const refsOf = (c: Cron) => [...new Set([c.destination?.target, c.sessionRef])].filter((ref) => ref !== undefined);
  const personaThreads =
    (await ctx.deps.sessions?.threadsWithPersona(personaId, [...new Set(crons.flatMap(refsOf))])) ?? new Set();
  return crons
    .filter(
      (c) =>
        c.ownerScopeId === scopeId("persona", personaId) ||
        pinned.has(c.ownerScopeId) ||
        refsOf(c).some((ref) => personaThreads.has(ref)),
    )
    .map(({ id, title, action, message, schedule, enabled }) => ({ id, title, action, message, schedule, enabled }));
}

async function granteeLabel(ctx: ApiCtx, scopeId: string): Promise<string | undefined> {
  const [kind, ...rest] = scopeId.split(":");
  const ref = rest.join(":");
  if (kind === "channel")
    return ctx.app.channelName(ref).catch(swallowAs(`persona grantee label ${scopeId}`, undefined));
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

function auditPersona(ctx: ApiCtx, principalId: string, personaId: string, action: string, resource: string): void {
  audit(ctx, { principalId, action, resource, scopeLabel: scopeId("persona", personaId) });
}

async function deletePersona(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId || !requirePersonAuthority(ctx)) return;
  const id = ctx.params.id!;
  if (!(await actionApproved(ctx, { summary: `Delete persona ${id}` }))) return;
  const result = await personas.remove(principalId, id, (grantId) =>
    auditPersona(ctx, principalId, id, "keychain.revoke", grantId),
  );
  if (result.status === "ok") auditPersona(ctx, principalId, id, "persona.delete", id);
  respond(ctx, result, "deleted");
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
  if (!personas || !principalId || !requirePersonAuthority(ctx)) return;
  const access = isObj(ctx.body) ? ctx.body.access : undefined;
  respond(ctx, await personas.setAccess(principalId, ctx.params.id!, access), "access");
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
  if (!personas || !principalId || !requirePersonAuthority(ctx)) return;
  const credentialId = isObj(ctx.body) ? ctx.body.credentialId : undefined;
  const id = ctx.params.id!;
  const summary = `Lend credential ${String(credentialId)} to persona ${id}`;
  if (!(await actionApproved(ctx, { summary }))) return;
  await keychainResult(
    ctx,
    async () => {
      const result = await personas.attachCredential(principalId, id, credentialId);
      if (result.status === "ok") auditPersona(ctx, principalId, id, "persona.credential.attach", result.value.grantId);
      return result;
    },
    "credential",
  );
}

async function detachCredential(ctx: ApiCtx): Promise<void> {
  const personas = service(ctx);
  const principalId = personas && principalOf(ctx, "body");
  if (!personas || !principalId || !requirePersonAuthority(ctx)) return;
  const [id, grantId] = [ctx.params.id!, ctx.params.grantId!];
  await keychainResult(
    ctx,
    async () => {
      const result = await personas.detachCredential(principalId, id, grantId, (revoked) =>
        auditPersona(ctx, principalId, id, "keychain.revoke", revoked),
      );
      if (result.status === "ok") auditPersona(ctx, principalId, id, "persona.credential.detach", grantId);
      return result;
    },
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
  const stored = !viewed && ctx.capability?.botActor ? await ctx.deps.sessions?.get(sessionId) : null;
  if (stored && !sessionVisibleTo(ctx.capability!, stored))
    return sendJson(ctx.res, 403, { error: "forbidden", message: "this conversation is no longer accessible" });
  if (!viewed) return sendJson(ctx.res, 404, { error: "not_found" });
  const personaId = isObj(ctx.body) ? ctx.body.personaId : undefined;
  if (personaId !== null && (typeof personaId !== "string" || !personaId))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "personaId (string or null) required" });
  respond(ctx, await personas.assign(principalId, viewed.session, personaId), "persona");
}

async function authorizePersonaSlack(
  ctx: ApiCtx,
  principalId: string,
): Promise<{ id: string; name: string; description: string } | null> {
  const personas = service(ctx);
  if (!personas) return null;
  if (!ctx.deps.slackInstallation) {
    sendJson(ctx.res, 404, { error: "not_configured" });
    return null;
  }
  const id = ctx.params.id!;
  const detail = await personas.detail(principalId, id);
  if (detail.status === "ok") {
    if (detail.value.role === "owner" || (await isOrgAdmin(ctx, principalId))) {
      return { id: detail.value.id, name: detail.value.name, description: detail.value.description };
    }
    sendJson(ctx.res, 403, { error: "forbidden", message: "only an org admin or persona owner can manage Slack apps" });
    return null;
  }
  respond(ctx, detail, "persona");
  return null;
}

async function getPersonaSlack(ctx: ApiCtx): Promise<void> {
  const principalId = principalOf(ctx, "query");
  if (!principalId) return;
  const persona = await authorizePersonaSlack(ctx, principalId);
  if (!persona) return;
  sendJson(ctx.res, 200, await ctx.deps.slackInstallation!.appStatus(persona.id, persona.name));
}

async function createPersonaSlack(ctx: ApiCtx): Promise<void> {
  const principalId = principalOf(ctx, "body");
  if (!principalId) return;
  const persona = await authorizePersonaSlack(ctx, principalId);
  if (!persona) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  let configToken: string | undefined;
  if (typeof body.refreshToken === "string" && body.refreshToken.trim()) configToken = body.refreshToken;
  else if (typeof body.configToken === "string") configToken = body.configToken;
  try {
    const created = await ctx.deps.slackInstallation!.createApp({
      personaId: persona.id,
      name: persona.name,
      description: persona.description,
      ...(configToken ? { configToken } : {}),
      saveOrgConfigToken: false,
      ...(body.orgDeploy === true ? { orgDeploy: true } : {}),
      updatedBy: principalId,
    });
    audit(ctx, {
      principalId,
      action: "persona-slack.create",
      resource: "persona-slack",
      scopeLabel: scopeId("persona", persona.id),
    });
    sendJson(ctx.res, 200, created.status);
  } catch (error) {
    sendJson(ctx.res, 400, { error: "slack_app_create_failed", message: errMessage(error) });
  }
}

async function putPersonaSlack(ctx: ApiCtx): Promise<void> {
  const principalId = principalOf(ctx, "body");
  if (!principalId) return;
  const persona = await authorizePersonaSlack(ctx, principalId);
  if (!persona) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const botToken = typeof body.botToken === "string" ? body.botToken : "";
  const signingSecret = typeof body.signingSecret === "string" ? body.signingSecret : "";
  const appId = typeof body.appId === "string" ? body.appId : undefined;
  try {
    const status = await ctx.deps.slackInstallation!.attachHttpApp({
      personaId: persona.id,
      botToken,
      signingSecret,
      ...(appId ? { appId } : {}),
      updatedBy: principalId,
    });
    audit(ctx, {
      principalId,
      action: "persona-slack.attach",
      resource: "persona-slack",
      scopeLabel: scopeId("persona", persona.id),
    });
    sendJson(ctx.res, 200, status);
  } catch (error) {
    sendJson(ctx.res, 400, { error: "invalid_persona_slack", message: errMessage(error) });
  }
}

async function deletePersonaSlack(ctx: ApiCtx): Promise<void> {
  const principalId = principalOf(ctx, "body");
  if (!principalId) return;
  const persona = await authorizePersonaSlack(ctx, principalId);
  if (!persona) return;
  const deleteRemote =
    ctx.url.searchParams.get("deleteRemote") === "true" || (isObj(ctx.body) && ctx.body.deleteRemote === true);
  try {
    await ctx.deps.slackInstallation!.deleteApp({
      personaId: persona.id,
      updatedBy: principalId,
      deleteRemote,
    });
    audit(ctx, {
      principalId,
      action: "persona-slack.delete",
      resource: "persona-slack",
      scopeLabel: scopeId("persona", persona.id),
    });
    sendJson(ctx.res, 200, await ctx.deps.slackInstallation!.appStatus(persona.id, persona.name));
  } catch (error) {
    sendJson(ctx.res, 400, { error: "slack_app_delete_failed", message: errMessage(error) });
  }
}

export const personaRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...withActor("query.principalId", [
    { method: "GET", path: "/v1/personas", browser: true, auth: "either", handle: listPersonas },
    { method: "GET", path: "/v1/personas/:id", browser: true, auth: "either", handle: getPersona },
    { method: "GET", path: "/v1/personas/:id/versions", browser: true, auth: "either", handle: listPersonaVersions },
    { method: "GET", path: "/v1/personas/:id/slack", browser: true, auth: "either", handle: getPersonaSlack },
  ]),
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/personas", browser: true, auth: "either", handle: createPersona },
    { method: "PATCH", path: "/v1/personas/:id", browser: true, auth: "either", handle: updatePersona },
    { method: "DELETE", path: "/v1/personas/:id", browser: "self", auth: "either", handle: deletePersona },
    {
      method: "POST",
      path: "/v1/personas/:id/versions/:version/restore",
      browser: true,
      auth: "either",
      handle: restorePersonaVersion,
    },
    { method: "PUT", path: "/v1/personas/:id/access", browser: true, auth: "either", handle: setPersonaAccess },
    { method: "POST", path: "/v1/personas/:id/credentials", browser: "self", auth: "either", handle: attachCredential },
    {
      method: "DELETE",
      path: "/v1/personas/:id/credentials/:grantId",
      browser: "self",
      auth: "either",
      handle: detachCredential,
    },
    {
      method: "POST",
      path: "/v1/personas/:id/slack/create",
      browser: true,
      auth: "either",
      handle: createPersonaSlack,
    },
    { method: "PUT", path: "/v1/personas/:id/slack", browser: true, auth: "either", handle: putPersonaSlack },
    { method: "DELETE", path: "/v1/personas/:id/slack", browser: true, auth: "either", handle: deletePersonaSlack },
    { method: "PUT", path: "/v1/sessions/:id/persona", browser: true, auth: "either", handle: setSessionPersona },
  ]),
];
