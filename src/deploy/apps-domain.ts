import { boundTenant } from "../tenants/context.ts";
import { tenantEnv } from "../tenants/settings.ts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface AppsDomainDeps {
  deployAppsDomain?: string;
  deployAppsTenantSubdomain?: string;
}

export function isAppLabel(value: string): boolean {
  return LABEL.test(value);
}

function hostOfUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return HOSTNAME.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The bound tenant's own web host, from its PUBLIC_WEB_URL setting. */
export function tenantWebHost(): string | undefined {
  if (boundTenant() === undefined) return undefined;
  return hostOfUrl(tenantEnv("PUBLIC_WEB_URL"));
}

/**
 * The apps domain for work bound to the current tenant. A deployment-wide
 * DEPLOY_APPS_DOMAIN wins; otherwise, with DEPLOY_APPS_TENANT_SUBDOMAIN set, each
 * tenant serves apps under `<subdomain>.<its own web host>`.
 */
export function appsDomainOf(deps: AppsDomainDeps): string | undefined {
  if (deps.deployAppsDomain) return deps.deployAppsDomain;
  const label = deps.deployAppsTenantSubdomain;
  if (!label) return undefined;
  const host = tenantWebHost();
  return host ? `${label}.${host}` : undefined;
}

export function appUrlOf(deps: AppsDomainDeps, slug: string): string | undefined {
  const domain = appsDomainOf(deps);
  return domain && isAppLabel(slug) ? `https://${slug}.${domain}/` : undefined;
}

/**
 * Splits `<app>.<label>.<tenant host>` into the app name and the tenant host. The
 * caller resolves the tenant from the tenant host, never from the app name.
 */
export function parseTenantAppHost(host: string, label: string): { app: string; tenantHost: string } | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  const marker = `.${label}.`;
  const at = h.indexOf(marker);
  if (at <= 0) return undefined;
  const app = h.slice(0, at);
  const tenantHost = h.slice(at + marker.length);
  if (!LABEL.test(app) || !HOSTNAME.test(tenantHost)) return undefined;
  return { app, tenantHost };
}

/** The web origin users reach this tenant at: its own PUBLIC_WEB_URL, else the deployment's. */
export function webUrlBase(deploymentWebUrl: string | undefined): string | undefined {
  const own = boundTenant() === undefined ? undefined : tenantEnv("PUBLIC_WEB_URL");
  return (own && hostOfUrl(own) ? own : deploymentWebUrl)?.replace(/\/+$/, "");
}
