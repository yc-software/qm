import { requireDeploymentControl } from "./background-work.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function itemsPromotion(ctx: ApiCtx): Promise<void> {
  if (!requireDeploymentControl(ctx)) return;
  const promotion = ctx.deps.itemsPromotion;
  if (!promotion) return sendJson(ctx.res, 409, { error: "items_promotion_not_staged" });
  if (ctx.method === "GET") await promotion.preflight();
  if (ctx.method === "POST") {
    if (
      !isObj(ctx.body) ||
      ctx.body.writersStopped !== true ||
      ctx.body.deploymentId !== ctx.deps.backgroundOwnership!.deploymentId ||
      Object.keys(ctx.body).some((key) => !["writersStopped", "deploymentId"].includes(key))
    )
      return sendJson(ctx.res, 400, { error: "invalid_items_promotion" });
    await promotion.promote(true);
  }
  sendJson(ctx.res, 200, {
    deploymentId: ctx.deps.backgroundOwnership!.deploymentId,
    ready: await promotion.refresh(),
  });
}

export const itemsPromotionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/items-promotion", auth: "source", handle: itemsPromotion },
  { method: "POST", path: "/v1/items-promotion", auth: "source", handle: itemsPromotion },
];
