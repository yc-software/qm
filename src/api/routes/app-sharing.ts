import { appView } from "../app.ts";
import { sendJson } from "../http.ts";
import { livePersonTurn } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
import { sendShareFailure } from "./sharing.ts";

async function setAppConnectors(ctx: ApiCtx): Promise<void> {
  const { res, app, params, body, capability, actor } = ctx;
  const principalId = capability ? capability.actorId : actor?.p;
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "only the publisher, in a live conversation or signed in, can lend an app their connectors",
    });
  if (!(await livePersonTurn(ctx))) return;
  const connectors = (body as { connectors?: unknown }).connectors;
  if (!Array.isArray(connectors) || !connectors.every((host) => typeof host === "string"))
    return sendJson(res, 400, { error: "bad_request", message: "connectors (array of connected-app hosts) required" });
  try {
    const publishedApp = await app.setAppConnectors(params.id!, connectors, { createdBy: principalId });
    return sendJson(res, 200, { app: appView(publishedApp) });
  } catch (e) {
    return sendShareFailure(res, e);
  }
}

export const appSharingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/apps/:id/connectors", auth: "either", handle: setAppConnectors },
];
