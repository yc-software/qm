const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** PORTAL_APPS_TENANT_SUBDOMAIN: one DNS label; each tenant then serves apps at `<app>.<label>.<tenant host>`. */
export function tenantAppsSubdomain(raw: string | undefined): string | undefined {
  const label = raw?.trim().toLowerCase();
  if (!label) return undefined;
  if (!LABEL.test(label)) throw new Error(`PORTAL_APPS_TENANT_SUBDOMAIN (${label}) must be one DNS label, like apps`);
  return label;
}

/** Splits `<app>.<label>.<tenant host>`; the tenant is resolved from the tenant host alone. */
export function parseTenantAppHost(host: string, label: string): { app: string; tenantHost: string } | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const marker = `.${label}.`;
  const at = h.indexOf(marker);
  if (at <= 0) return undefined;
  const app = h.slice(0, at);
  const tenantHost = h.slice(at + marker.length);
  if (!LABEL.test(app) || !HOSTNAME.test(tenantHost)) return undefined;
  return { app, tenantHost };
}

/** A web host can carry a domain cookie only if it is a real multi-label hostname. */
export function cookieHost(host: string | undefined): string | undefined {
  const h = host?.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return h && HOSTNAME.test(h) ? h : undefined;
}
