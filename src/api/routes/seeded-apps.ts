import { appView } from "../app.ts";
import { sendJson } from "../http.ts";
import { forInboxLoopsPeople } from "./loops.ts";
import { routeSignOff } from "../action-approval.ts";
import type { ApiCtx, Route } from "./route.ts";
import { sendShareFailure } from "./sharing.ts";

async function ensureSeededApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body, actor } = ctx;
  if (!actor) return sendJson(res, 403, { error: "forbidden", message: "Sign in to open your apps." });
  const { signOff, held } = routeSignOff(ctx);
  try {
    const reset = (body as { reset?: unknown } | null)?.reset === true;
    const d = await app.ensureSeededApp(actor.p, params.seed!, { reset, signOff });
    if (held()) return;
    return sendJson(res, 200, {
      app: { ...appView(d), permission: "write", webUrl: app.appUrl(d) ?? `/d/${encodeURIComponent(d.name ?? d.id)}/` },
    });
  } catch (e) {
    return sendShareFailure(res, e);
  }
}

export const seededAppRoutes: ReadonlyArray<Route<ApiCtx>> = forInboxLoopsPeople([
  { method: "POST", path: "/v1/seeded-apps/:seed", actor: "person", auth: "source", handle: ensureSeededApp },
]);
