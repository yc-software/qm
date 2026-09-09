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
  const copyTimeoutSec =
    typeof b.copyTimeoutSec === "number" && Number.isFinite(b.copyTimeoutSec)
      ? Math.min(7200, Math.max(60, Math.floor(b.copyTimeoutSec)))
      : undefined;
  const strategy = b.strategy === "snapshot" ? ("snapshot" as const) : undefined;
  const resumeBlobId =
    strategy === "snapshot" && typeof b.resumeBlobId === "string" && /^[0-9a-f]{32}$/.test(b.resumeBlobId)
      ? b.resumeBlobId
      : undefined;
  if (!to || !runner.availableBackends().includes(to)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `to must be one of: ${runner.availableBackends().join(", ")}`,
    });
  }
  try {
    if ((await deps.sandboxResources?.resolve(scopeId)) !== undefined)
      throw new Error("this scope uses sandbox resources; change its default independently");
    const result = await runner.migrateScope(scopeId, to, reason, {
      force,
      ...(copyTimeoutSec !== undefined ? { copyTimeoutSec } : {}),
      ...(strategy ? { strategy } : {}),
      ...(resumeBlobId ? { resumeBlobId } : {}),
    });
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

export async function manageSandboxResources(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const resources = ctx.deps.sandboxResources;
  if (!resources) return sendJson(ctx.res, 404, { error: "not_supported" });
  const scopeId = ctx.params.scopeId!;
  const input = (ctx.body ?? {}) as Record<string, unknown>;
  try {
    if (ctx.req.method === "GET") return sendJson(ctx.res, 200, await resources.list(actor.id, scopeId));
    if (input.action === "retire") {
      if (typeof input.sandboxId !== "string") throw new Error("retire requires sandboxId");
      const record = await resources.access(actor.id, input.sandboxId);
      if (record.ownerScopeId !== scopeId) throw new Error("sandbox belongs to another scope");
      await resources.retire(actor.id, input.sandboxId);
      audit(ctx.deps, {
        principalId: actor.id,
        action: "sandbox.retire",
        resource: input.sandboxId,
        scopeLabel: scopeId,
      });
      return sendJson(ctx.res, 200, { retired: input.sandboxId });
    }
    if (input.action === "default") {
      if (input.sandboxId !== null && typeof input.sandboxId !== "string")
        throw new Error("sandboxId must be an ID or null");
      await resources.setDefault(actor.id, scopeId, input.sandboxId);
      audit(ctx.deps, {
        principalId: actor.id,
        action: "sandbox.default",
        resource: String(input.sandboxId),
        scopeLabel: scopeId,
      });
      return sendJson(ctx.res, 200, { defaultSandboxId: input.sandboxId });
    }
    if (input.action !== "create" || typeof input.backend !== "string")
      throw new Error("choose create with backend, or default with sandboxId");
    const record = await resources.create(
      actor.id,
      scopeId,
      input.backend,
      typeof input.name === "string" ? input.name : undefined,
    );
    audit(ctx.deps, { principalId: actor.id, action: "sandbox.create", resource: record.id, scopeLabel: scopeId });
    return sendJson(ctx.res, 201, record);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "sandbox_request_failed", message: errMessage(error) });
  }
}
