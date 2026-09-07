import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { TaintUnclearableError } from "../../../sessions/session-store.ts";

const MAX_FLAGS = 200;

export async function listSecurityFlags(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const requested = Number(ctx.url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_FLAGS) : 50;
  const events = (await ctx.deps.auditLog?.tail({ limit: MAX_FLAGS })) ?? [];
  const flags = events
    .filter((event) => event.action === "security_posture.flagged" || event.action === "security_posture.quarantine")
    .slice(0, limit)
    .map((event) => ({
      at: event.at,
      principal: event.principalId,
      scope: event.scopeLabel,
      surface: event.resource,
      detail: event.detail,
    }));
  audit(ctx.deps, {
    principalId: actor.id,
    action: "security_posture.flags.read",
    resource: "security-flags",
    scopeLabel: scope,
  });
  sendJson(ctx.res, 200, { flags });
}

export async function releaseSecurityTaint(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const sessionId = (ctx.body as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "sessionId required" });
    return;
  }
  let released: boolean;
  try {
    released = (await ctx.deps.sessions?.clearSecurityTaint(sessionId)) ?? false;
  } catch (err) {
    if (!(err instanceof TaintUnclearableError)) throw err;
    audit(ctx.deps, {
      principalId: actor.id,
      action: "security_posture.release",
      resource: sessionId,
      scopeLabel: scope,
      status: "refused",
      detail: err.message,
    });
    sendJson(ctx.res, 409, { error: "taint_unclearable", message: err.message });
    return;
  }
  if (!released) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return;
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: "security_posture.release",
    resource: sessionId,
    scopeLabel: scope,
    status: "ok",
  });
  sendJson(ctx.res, 200, { released: true, sessionId });
}
