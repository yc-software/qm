import { toolManifest } from "../../harness/tool-manifest.ts";
import { personalScope } from "../../types.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";

async function getToolManifest(ctx: ApiCtx): Promise<RouteResult> {
  const principal = ctx.actor?.p;
  if (!principal) return reply(401, { error: "unauthorized" });
  const { deps } = ctx;
  const tools = toolManifest({
    controlTools: Boolean(deps.signingSecret && deps.apiBaseUrl),
    surfaceTools: false,
    surfaceName: "web",
    delegateWork: false,
    sessionTools: true,
    readOnly: false,
    canvasInstall: (await deps.featureFlags?.enabled("ui_canvas", personalScope(principal))) === true,
    adminOperations: (await deps.admin?.adminStatusOf({ id: principal, type: "internal" }))?.isAdmin === true,
    connectorTools: (await deps.mcpToolService?.toolDefsFor(principal)) ?? [],
    clientTools: [],
  });
  return ok({ tools });
}

export const toolManifestRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/tool-manifest", actor: "query.principalId", auth: "source", handle: getToolManifest },
];
