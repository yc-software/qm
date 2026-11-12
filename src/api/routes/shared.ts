import { orgId as configOrgId, orgScope as configOrgScope } from "../../config.ts";
import { scopeId, type Principal } from "../../types.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { AuditEvent } from "../../audit/audit-log.ts";
import { adminStatusFromGrants } from "../../admin/admin-service.ts";
import { canonicalPerson, samePerson } from "../../directory/person.ts";
import { isTerminal, type Run } from "../../runs/run-store.ts";
import type { ServerDeps } from "../deps.ts";
import { tenantOf, type ApiCtx, type BaseCtx } from "./route.ts";
import type { Tenant } from "../../tenants/context.ts";
import { headerValue, refuseWithoutPerson, sendJson } from "../http.ts";
import { currentModelRequestContext } from "../../model/request-context.ts";
import { constantTimeEqual } from "../../util/crypto.ts";
import { personAtKeyboard } from "../artifact-share.ts";

export const orgScope = (_deps?: unknown): string => configOrgScope();

export function exportTokenAccepted(ctx: Pick<BaseCtx, "req" | "res">, token: string | undefined): boolean {
  if (!token) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return false;
  }
  const authorization = ctx.req.headers.authorization;
  if (typeof authorization === "string" && constantTimeEqual(authorization, `Bearer ${token}`)) return true;
  sendJson(ctx.res, 401, { error: "unauthorized" });
  return false;
}

export { isObj } from "../../util/objects.ts";

export function personalCapability(ctx: Pick<ApiCtx, "capability" | "actor">): CapabilityClaims | null {
  if (ctx.capability) return ctx.capability;
  return ctx.actor ? { actorId: ctx.actor.p, scopeId: scopeId("personal", ctx.actor.p), exp: ctx.actor.exp } : null;
}

export function audit(ctx: Pick<ApiCtx, "deps" | "tenant">, e: Omit<AuditEvent, "at">): void {
  ctx.deps.auditLog?.record(tenantOf(ctx), { at: Date.now(), ...e });
}

export async function activeRun(ctx: ApiCtx): Promise<boolean> {
  const cap = ctx.capability;
  if (!cap) return true;
  const run = cap.runId ? await ctx.deps.runs?.get(cap.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !cap.runLeaseToken ||
    run.leaseToken !== cap.runLeaseToken ||
    run.attempts !== cap.runAttempt ||
    run.sessionId !== cap.threadRef ||
    !samePerson(run.request.actor.id, cap.actorId) ||
    (run.leaseExpiresAt ?? 0) <= Date.now()
  ) {
    sendJson(ctx.res, 403, {
      error: "inactive_run",
      message:
        "This call needs the current token of a running turn: the turn that issued this token is no longer running, or the token belongs to another run. A background job or script that outlives its turn loses this access; make the call from a foreground command while the turn is running.",
    });
    return false;
  }
  return true;
}

export async function livePersonTurn(ctx: ApiCtx): Promise<boolean> {
  if (ctx.capability && !personAtKeyboard(ctx.capability)) {
    refuseWithoutPerson(ctx.res);
    return false;
  }
  return activeRun(ctx);
}

function rawAdminActor(ctx: Pick<ApiCtx, "req" | "deps" | "capability" | "actor">): Principal | null {
  if (ctx.capability) return { id: ctx.capability.actorId, type: "internal" };
  if (ctx.actor)
    return ctx.deps.admin?.resolveActor(`${ctx.actor.p}@${configOrgId()}`) ?? { id: ctx.actor.p, type: "internal" };
  return ctx.deps.admin?.resolveActor(headerValue(ctx.req, "x-admin-actor")) ?? null;
}

export function adminActorFrom(ctx: Pick<ApiCtx, "req" | "deps" | "capability" | "actor">): Principal | null {
  const actor = rawAdminActor(ctx);
  return actor ? { ...actor, id: canonicalPerson(actor.id) } : null;
}

export async function adminStanding(
  deps: ServerDeps,
  tenant: Tenant,
  principalId: string,
): Promise<"inactive" | "admin" | "member"> {
  const id = canonicalPerson(principalId);
  if (!(await activePrincipal(deps, id))) return "inactive";
  return adminStatusFromGrants((await deps.admin?.listGrants(tenant)) ?? [], id).isAdmin ? "admin" : "member";
}

export async function authorizeAdmin(
  ctx: Pick<ApiCtx, "req" | "res" | "deps" | "capability" | "actor" | "tenant">,
  scope: string,
): Promise<Principal | null> {
  const { res, deps } = ctx;
  if (!deps.admin) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  const actor = adminActorFrom(ctx);
  const standing = actor ? await adminStanding(deps, tenantOf(ctx), actor.id) : "member";
  if (standing === "inactive") {
    sendJson(res, 403, { error: "forbidden", message: "this principal is no longer active" });
    return null;
  }
  if (actor && standing === "admin") {
    Object.assign(currentModelRequestContext(), { actorId: actor.id, scopeId: scope });
    return actor;
  }
  sendJson(res, 403, { error: "forbidden", message: "admin grant required for this scope" });
  return null;
}

export async function activePrincipal(deps: ServerDeps, principalId: string): Promise<boolean> {
  if (!deps.identity) return true;
  await deps.identity.refresh();
  return deps.identity.classify(principalId).type === "internal";
}

export async function requireScopedAdmin(
  ctx: Pick<ApiCtx, "req" | "res" | "deps" | "capability" | "actor" | "url">,
): Promise<{ actor: Principal; scope: string } | null> {
  const scope = ctx.url.searchParams.get("scope") ?? "";
  if (!scope) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "scope required" });
    return null;
  }
  const actor = await authorizeAdmin(ctx, scope);
  return actor ? { actor, scope } : null;
}

export { resolveCapabilityDestination } from "../capability-destination.ts";

export async function verifiedConversationSpeaker(
  ctx: Pick<ApiCtx, "deps" | "capability">,
  onBehalfOf: string,
): Promise<{ principalId: string } | { error: string }> {
  const threadRef = ctx.capability?.threadRef;
  const { runs, signals, identity } = ctx.deps;
  if (!threadRef || !runs || !signals || !identity) {
    return { error: "this turn has no conversation to verify the speaker against" };
  }
  let turnRuns: Run[];
  if (ctx.capability?.runId) {
    const own = await runs.get(ctx.capability.runId);
    if (!own || own.sessionId !== threadRef || isTerminal(own.status)) {
      return { error: "no live turn to verify the speaker against" };
    }
    turnRuns = [own];
  } else {
    turnRuns = await runs.inFlightForThread(threadRef);
    if (!turnRuns.length) return { error: "no live turn to verify the speaker against" };
  }
  const spoke = turnRuns.map((run) => run.request.actor.id);
  for (const run of turnRuns) {
    for (const id of await signals.steerAuthors(run.id)) spoke.push(identity.classify(id).id);
  }
  const match = spoke.find((p) => samePerson(p, onBehalfOf));
  if (!match) return { error: `${onBehalfOf} hasn't spoken in this turn` };
  if (!identity.isInternal(identity.classify(match))) {
    return { error: `${onBehalfOf} isn't an internal teammate` };
  }
  return { principalId: match };
}
