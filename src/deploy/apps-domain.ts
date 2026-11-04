import { hostOfUrl, isDnsLabel } from "../../plugins/chassis/src/hostnames.ts";
import { boundTenant } from "../tenants/context.ts";
import { tenantEnv } from "../tenants/settings.ts";

export interface AppsDomainDeps {
  deployAppsDomain?: string;
  deployAppsTenantSubdomain?: string;
}

function tenantWebHost(): string | undefined {
  if (boundTenant() === undefined) return undefined;
  return hostOfUrl(tenantEnv("PUBLIC_WEB_URL"));
}

export function appsDomainOf(deps: AppsDomainDeps): string | undefined {
  if (deps.deployAppsDomain) return deps.deployAppsDomain;
  const label = deps.deployAppsTenantSubdomain;
  if (!label) return undefined;
  const host = tenantWebHost();
  return host ? `${label}.${host}` : undefined;
}

export function appUrlOf(deps: AppsDomainDeps, slug: string): string | undefined {
  const domain = appsDomainOf(deps);
  return domain && isDnsLabel(slug) ? `https://${slug}.${domain}/` : undefined;
}

export function webUrlBase(deploymentWebUrl: string | undefined): string | undefined {
  const own = boundTenant() === undefined ? undefined : tenantEnv("PUBLIC_WEB_URL");
  return (own && hostOfUrl(own) ? own : deploymentWebUrl)?.replace(/\/+$/, "");
}
