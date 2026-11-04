import { isTenantId } from "../../tenants/context.ts";
import { isHostname, requestHost } from "../../tenants/tenancy.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

function target(ctx: ApiCtx): { tenant: string; host?: string } | undefined {
  const tenant = ctx.params.tenant ?? "";
  const host = ctx.params.host === undefined ? undefined : requestHost(ctx.params.host);
  if (!isTenantId(tenant) || (host !== undefined && !isHostname(host))) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "expected a tenant uuid and a lowercase hostname" });
    return undefined;
  }
  return { tenant, ...(host === undefined ? {} : { host }) };
}

function tenancyOf(ctx: ApiCtx) {
  if (!ctx.deps.tenancy) sendJson(ctx.res, 404, { error: "not_configured", message: "tenancy needs Postgres" });
  return ctx.deps.tenancy;
}

async function listHosts(ctx: ApiCtx): Promise<void> {
  const tenancy = tenancyOf(ctx);
  const t = tenancy && target(ctx);
  if (!tenancy || !t) return;
  const hosts = await tenancy.hosts(t.tenant);
  if (!hosts) return sendJson(ctx.res, 404, { error: "unknown_tenant" });
  sendJson(ctx.res, 200, { hosts });
}

async function mapHost(ctx: ApiCtx): Promise<void> {
  const tenancy = tenancyOf(ctx);
  const t = tenancy && target(ctx);
  if (!tenancy || !t?.host) return;
  const outcome = await tenancy.mapHost(t.tenant, t.host);
  if (outcome === "unknown_tenant") return sendJson(ctx.res, 404, { error: "unknown_tenant" });
  if (outcome === "taken")
    return sendJson(ctx.res, 409, { error: "host_taken", message: "this host belongs to another tenant" });
  sendJson(ctx.res, 200, { host: t.host, tenant: t.tenant });
}

async function unmapHost(ctx: ApiCtx): Promise<void> {
  const tenancy = tenancyOf(ctx);
  const t = tenancy && target(ctx);
  if (!tenancy || !t?.host) return;
  if (!(await tenancy.unmapHost(t.tenant, t.host))) return sendJson(ctx.res, 404, { error: "not_found" });
  sendJson(ctx.res, 200, { ok: true });
}

async function lookupHost(ctx: ApiCtx): Promise<void> {
  const tenancy = tenancyOf(ctx);
  if (!tenancy) return;
  const resolved = await tenancy.hostTenant(requestHost(ctx.params.host));
  const sole = await tenancy.soleTenant();
  const tenant = resolved.tenant ?? (resolved.multi ? undefined : sole);
  sendJson(ctx.res, 200, {
    tenant: tenant ?? null,
    multi: resolved.multi,
    sole: tenant !== undefined && tenant === sole,
  });
}

async function updateSettings(ctx: ApiCtx): Promise<void> {
  const tenancy = tenancyOf(ctx);
  const t = tenancy && target(ctx);
  if (!tenancy || !t) return;
  const body = ctx.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "expected an object of settings" });
  const result = await tenancy.updateSettings(t.tenant, Object.fromEntries(Object.entries(body)));
  if (result.ok) return sendJson(ctx.res, 200, { keys: result.keys });
  if (result.error === "unknown_tenant") return sendJson(ctx.res, 404, { error: "unknown_tenant" });
  sendJson(ctx.res, 400, { error: "invalid_settings", message: result.message });
}

export const tenancyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/operator/hosts/:host", auth: "source", tenant: "none", handle: lookupHost },
  { method: "GET", path: "/v1/operator/tenants/:tenant/hosts", auth: "source", tenant: "none", handle: listHosts },
  { method: "PUT", path: "/v1/operator/tenants/:tenant/hosts/:host", auth: "source", tenant: "none", handle: mapHost },
  {
    method: "DELETE",
    path: "/v1/operator/tenants/:tenant/hosts/:host",
    auth: "source",
    tenant: "none",
    handle: unmapHost,
  },
  {
    method: "PATCH",
    path: "/v1/operator/tenants/:tenant/settings",
    auth: "source",
    tenant: "none",
    handle: updateSettings,
  },
];
