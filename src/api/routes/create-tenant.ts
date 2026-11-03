import { isTenantId } from "../../tenants/context.ts";
import { sendJson } from "../http.ts";
import { requireOperatorControl } from "./background-work.ts";
import type { ApiCtx, Route } from "./route.ts";

async function createTenant(ctx: ApiCtx): Promise<void> {
  if (!requireOperatorControl(ctx)) return;
  const create = ctx.deps.createTenant;
  if (!create) return sendJson(ctx.res, 503, { error: "create_tenant_unavailable" });
  const tenant = ctx.params.tenant;
  if (!isTenantId(tenant))
    return sendJson(ctx.res, 400, { error: "invalid_tenant", message: "the tenant id must be a UUID" });
  const created = await create(tenant);
  const ownership = ctx.deps.backgroundOwnership;
  if (ownership) await ownership.store.claimIfNeverSet(ownership.deploymentId);
  return sendJson(ctx.res, 200, created);
}

export const createTenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "PUT", path: "/v1/tenants/:tenant", actor: "system", auth: "source", handle: createTenant },
];
