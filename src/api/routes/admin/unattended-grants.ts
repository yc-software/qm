import { adminOperations } from "../../../tools/admin.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin } from "../shared.ts";
import type { ApiCtx, Route } from "../route.ts";
import { tenant } from "../../../tenant.ts";

export function unattendedGrantListing(routes: ReadonlyArray<Route<ApiCtx>>) {
  return routes.flatMap((route) => {
    if (!("path" in route) || !route.admin?.unattended) return [];
    const action = Object.entries(adminOperations).find(
      ([, op]) => op.method === route.method && `/v1/admin${op.path}` === route.path,
    )?.[0];
    const { grant, summary } = route.admin.unattended;
    return [{ grant, method: route.method, path: route.path, summary, ...(action ? { action } : {}) }];
  });
}

export async function listUnattendedGrants(ctx: ApiCtx, routes: ReadonlyArray<Route<ApiCtx>>): Promise<void> {
  const scope = tenant().orgScope;
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(ctx.deps, {
    principalId: actor.id,
    action: "unattended-grants.read",
    resource: "unattended-grants",
    scopeLabel: scope,
  });
  sendJson(ctx.res, 200, { grants: unattendedGrantListing(routes) });
}
