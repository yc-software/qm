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
  try {
    if (ctx.method === "DELETE") {
      if (!(await store.delete(id, actor.id))) return sendJson(ctx.res, 404, { error: "not_found" });
    } else {
      if (!isObj(ctx.body) || (ctx.body.id !== undefined && ctx.body.id !== id))
        return sendJson(ctx.res, 400, { error: "bad_request" });
      await store.upsert({ ...ctx.body, id }, actor.id);
    }
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(error) });
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: ctx.method === "DELETE" ? "model-registry.delete" : "model-registry.update",
    resource: id,
    scopeLabel: scope,
  });
  await store.refresh();
  return sendJson(ctx.res, 200, { ok: true });
}
