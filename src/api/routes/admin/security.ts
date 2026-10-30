import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { SECURITY_FLAGGED, SECURITY_TOOL_RESULT_QUARANTINE } from "../../../audit/audit-log.ts";

const MAX_FLAGS = 200;
const FLAG_ACTIONS = [SECURITY_FLAGGED, SECURITY_TOOL_RESULT_QUARANTINE];

export async function listSecurityFlags(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const requested = Number(ctx.url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_FLAGS) : 50;
  const events = (await ctx.deps.auditLog?.tail({ limit, action: FLAG_ACTIONS })) ?? [];
  const flags = events.map((event) => ({
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
