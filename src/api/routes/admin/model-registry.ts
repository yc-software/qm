import { ModelVerificationError } from "../../../model/model-verification.ts";
import { MODEL_REGISTRY, safeModelMetadata } from "../../../model/pi-models.ts";
import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope, isObj } from "../shared.ts";

export async function modelRegistry(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = ctx.deps.modelRegistry;
  if (!store) return sendJson(ctx.res, 404, { error: "not_found" });
  if (ctx.method === "GET") {
    await ctx.deps.refreshModels?.();
    const templates = MODEL_REGISTRY.flatMap(({ id }) => {
      const model = safeModelMetadata(id);
      return model && (model.provider === "openai" || model.provider === "anthropic") ? [model] : [];
    });
    return sendJson(ctx.res, 200, { models: await store.statuses(), templates });
  }
  const id = ctx.params.model;
  if (!id) return sendJson(ctx.res, 400, { error: "bad_request" });
  let verification: { verifiedAt: number; verificationScope: "organization" } | undefined;
  try {
    if (ctx.method === "DELETE") {
      if (!(await store.delete(id, actor.id))) return sendJson(ctx.res, 404, { error: "not_found" });
    } else {
      if (!isObj(ctx.body) || (ctx.body.id !== undefined && ctx.body.id !== id))
        return sendJson(ctx.res, 400, { error: "bad_request" });
      const { verify, ...spec } = ctx.body;
      if (verify !== true)
        return sendJson(ctx.res, 400, {
          error: "verification_consent_required",
          message:
            "Verify and enable sends a small billable synthetic request with organization credentials. Set verify: true to continue.",
        });
      verification = await store.upsert({ ...spec, id }, actor.id);
    }
  } catch (error) {
    if (error instanceof ModelVerificationError) {
      audit(ctx.deps, {
        principalId: actor.id,
        action: "model-registry.verification-failed",
        resource: id,
        scopeLabel: scope,
      });
      await store.refresh();
      return sendJson(
        ctx.res,
        ["configuration_conflict", "changed_during_verification"].includes(error.code) ? 409 : 422,
        { error: error.code, message: error.message },
      );
    }
    return sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(error) });
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: ctx.method === "DELETE" ? "model-registry.delete" : "model-registry.update",
    resource: id,
    scopeLabel: scope,
  });
  await store.refresh();
  return sendJson(ctx.res, 200, { ok: true, ...verification });
}
