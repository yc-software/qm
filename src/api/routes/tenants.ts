import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

async function tenantForHost({ res, url, deps }: ApiCtx): Promise<void> {
  const host = url.searchParams.get("host")?.toLowerCase() ?? "";
  const tenant = host && deps.tenants ? await deps.tenants.forHost(host) : null;
  if (!tenant) return sendJson(res, 404, { error: "not_found", message: "no tenant serves this host" });
  sendJson(res, 200, { tenant });
}

export const tenantRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/tenants/for-host",
    actor: "system",
    auth: "source",
    unbound: true,
    handle: tenantForHost,
  },
];
