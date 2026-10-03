import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

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
