import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

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
  const released = (await ctx.deps.sessions?.clearSecurityTaint(sessionId)) ?? false;
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
