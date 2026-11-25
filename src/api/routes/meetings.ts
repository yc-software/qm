import { scopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

async function meetingsEnabled(ctx: ApiCtx): Promise<void> {
  const user = ctx.actor?.p;
  ctx.res.setHeader("cache-control", "no-store");
  const enabled = Boolean(
    user && !ctx.actor?.imp && (await ctx.deps.featureFlags?.enabled("meeting_recorder", scopeId("personal", user))),
  );
  return sendJson(ctx.res, 200, { enabled, user: enabled ? user : null });
}

export const meetingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/meetings", browser: true, actor: "person", auth: "source", handle: meetingsEnabled },
];
