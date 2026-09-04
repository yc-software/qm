import { parseScopeId, type ScopeId } from "../../../types.ts";
import { errMessage } from "../../../util/errors.ts";
import type { SandboxBackendName } from "../../../sandbox/sandbox-routing.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

export async function listSandboxRoutes(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const runner = deps.sandboxMigration;
  if (!runner)
    return sendJson(res, 404, { error: "not_supported", message: "sandbox routing is not wired on this deployment" });
  audit(deps, {
    principalId: actor.id,
    action: "sandbox_routes.read",
    resource: "sandbox_routes",
    scopeLabel: orgScope(deps),
  });
  const routes = await runner.listRoutes();
  return sendJson(res, 200, {
    defaultBackend: runner.defaultBackend,
    availableBackends: runner.availableBackends(),
    routes: routes.map(([scopeId, r]) => ({ scopeId, ...r })),
  });
}

export async function migrateSandboxScope(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const runner = deps.sandboxMigration;
  if (!runner)
    return sendJson(res, 404, { error: "not_supported", message: "sandbox routing is not wired on this deployment" });
  const scopeId = params.scopeId! as ScopeId;
  if (parseScopeId(scopeId).kind === null) {
    return sendJson(res, 400, { error: "bad_request", message: "scopeId is not a valid scope id" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const to = typeof b.to === "string" ? (b.to as SandboxBackendName) : undefined;
  const reason = typeof b.reason === "string" ? b.reason : undefined;
  const force = b.force === true;
  if (!to || !runner.availableBackends().includes(to)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `to must be one of: ${runner.availableBackends().join(", ")}`,
    });
  }
  try {
    const result = await runner.migrateScope(scopeId, to, reason, { force });
    audit(deps, {
      principalId: actor.id,
      action: "sandbox_routes.migrate",
      resource:
        `${result.from}->${result.to} sha=${result.sha.slice(0, 12)}` +
        (result.capabilitiesLost.length ? ` lost=${result.capabilitiesLost.join("; ")}` : ""),
      scopeLabel: scopeId,
    });
    return sendJson(res, 200, result);
  } catch (err) {
    audit(deps, {
      principalId: actor.id,
      action: "sandbox_routes.migrate_failed",
      resource: errMessage(err).slice(0, 200),
      scopeLabel: scopeId,
    });
    return sendJson(res, 409, { error: "migration_failed", message: errMessage(err) });
  }
}
