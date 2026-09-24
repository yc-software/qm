import { decideDeploymentAccess, deploymentAccessHome } from "../../deploy/access-request.ts";
import { samePerson } from "../../directory/person.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import type { Delivery } from "../../types.ts";
import type { ApiCtx } from "./route.ts";
import { isObj } from "./shared.ts";

async function visibleNotices(ctx: ApiCtx): Promise<Delivery[] | null> {
  const principal = ctx.actor?.p;
  if (!principal || !ctx.deps.identity) return null;
  await ctx.deps.identity.refresh();
  if (ctx.deps.identity.classify(principal).type !== "internal") return null;
  const notices = [];
  for (const notice of await ctx.app.pendingDeliveries("app-notice")) {
    if (!samePerson(notice.destination.target, principal)) continue;
    const request = notice.destination.deploymentAccess;
    if (request && !(await deploymentAccessHome(ctx.app, request.deploymentId, principal))) continue;
    notices.push(notice);
  }
  return notices;
}

export async function listDeploymentNotices(ctx: ApiCtx): Promise<void> {
  const notices = await visibleNotices(ctx);
  if (!notices) return sendJson(ctx.res, 403, { error: "forbidden" });
  sendJson(ctx.res, 200, {
    notices: notices.map((notice) => ({
      id: notice.id,
      text: notice.text,
      createdAt: notice.createdAt,
      request: !!notice.destination.deploymentAccess,
      ...(notice.destination.deploymentShared
        ? { url: `/deployments/${encodeURIComponent(notice.destination.deploymentShared.deploymentId)}/` }
        : {}),
    })),
  });
}

export async function decideDeploymentNotice(ctx: ApiCtx): Promise<void> {
  const notices = await visibleNotices(ctx);
  if (!notices) return sendJson(ctx.res, 403, { error: "forbidden" });
  const notice = notices.find((row) => row.id === ctx.params.id);
  if (!notice) return sendJson(ctx.res, 404, { error: "not_found" });
  const action = isObj(ctx.body) ? ctx.body.action : undefined;
  const request = notice.destination.deploymentAccess;
  if (request ? action !== "approve" && action !== "decline" : action !== "dismiss")
    return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    const message = request
      ? await decideDeploymentAccess(
          ctx.app,
          ctx.deps.identity!,
          JSON.stringify(request),
          { externalId: ctx.actor!.p },
          action === "approve",
        )
      : "Dismissed.";
    await ctx.app.ackDelivery(notice.id);
    sendJson(ctx.res, 200, { ok: true, message });
  } catch (error) {
    sendJson(ctx.res, 403, { error: "forbidden", message: errMessage(error) });
  }
}
