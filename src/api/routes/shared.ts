import { orgId as configOrgId, orgScope as configOrgScope } from "../../config.ts";
import type { Principal } from "../../types.ts";
import type { AuditEvent } from "../../audit/audit-log.ts";
import { adminStatusFromGrants } from "../../admin/admin-service.ts";
import { samePerson } from "../../directory/person.ts";
import { isTerminal, type Run } from "../../runs/run-store.ts";
import type { ServerDeps } from "../deps.ts";
import type { ApiCtx } from "./route.ts";
import { headerValue, sendJson } from "../http.ts";

export const orgScope = (_deps?: unknown): string => configOrgScope();

export { isObj } from "../../util/objects.ts";

export function audit(deps: ServerDeps, e: Omit<AuditEvent, "at">): void {
  deps.auditLog?.record({ at: Date.now(), ...e });
}

export function adminActorFrom(ctx: Pick<ApiCtx, "req" | "deps" | "capability" | "actor">): Principal | null {
  if (ctx.capability) return { id: ctx.capability.actorId, type: "internal" };
  if (ctx.actor)
    return ctx.deps.admin?.resolveActor(`${ctx.actor.p}@${configOrgId()}`) ?? { id: ctx.actor.p, type: "internal" };
  return ctx.deps.admin?.resolveActor(headerValue(ctx.req, "x-admin-actor")) ?? null;
}

export async function authorizeAdmin(
  ctx: Pick<ApiCtx, "req" | "res" | "deps" | "capability" | "actor">,
  _scope: string,
): Promise<Principal | null> {
  const { res, deps } = ctx;
  if (!deps.admin) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  const grants = await deps.admin.listGrants();
  const actor = adminActorFrom(ctx);
  if (actor && !(await activePrincipal(deps, actor.id))) {
    sendJson(res, 403, { error: "forbidden", message: "this principal is no longer active" });
    return null;
  }
  if (actor && adminStatusFromGrants(grants, actor.id).isAdmin) return actor;
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
