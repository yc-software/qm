import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { inHostTenant, type HostTenantLookup } from "../../chassis/src/host-tenant.ts";
import { hostOfHeader, parseTenantAppHost } from "../../chassis/src/hostnames.ts";
import { json } from "../../chassis/src/http.ts";
import { boundTenant } from "../../chassis/src/tenant.ts";

export function tenantAppDomains(opts: { label?: string; appsDomain?: string; cookieDomain?: string }) {
  const webHost = new AsyncLocalStorage<string | undefined>();
  const tenantWebHost = (): string | undefined => (opts.label && boundTenant() ? webHost.getStore() : undefined);
  return {
    run: <T>(req: IncomingMessage, fn: () => T): T => webHost.run(hostOfHeader(req.headers.host), fn),
    tenantWebHost,
    cookieDomain: (): string | undefined => opts.cookieDomain ?? tenantWebHost(),
    appsDomain: (): string | undefined => {
      if (opts.appsDomain) return opts.appsDomain;
      const host = tenantWebHost();
      return host && opts.label ? `${opts.label}.${host}` : undefined;
    },
  };
}

function notFound(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  json(res, 404, { error: "not_found" });
}

export async function serveTenantHost(
  req: IncomingMessage,
  res: ServerResponse,
  routes: { label: string; lookup: HostTenantLookup; handle: () => Promise<void>; proxyApp: () => void },
): Promise<void> {
  const appHost = parseTenantAppHost(req.headers.host, routes.label);
  if (!appHost) return inHostTenant(routes.lookup, req, res, routes.handle);
  const owner = await routes.lookup(appHost.tenantHost);
  const self = await routes.lookup(appHost.host);
  if (self.tenant && owner.tenant) {
    console.error("[portal] host %s is a tenant web host and an app host of another tenant; refused", appHost.host);
    return notFound(req, res);
  }
  if (self.tenant) return inHostTenant(async () => self, req, res, routes.handle);
  if (!owner.tenant) return notFound(req, res);
  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  routes.proxyApp();
}
