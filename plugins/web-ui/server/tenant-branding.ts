import { createBrandingCache, type BrandingCache, type OrgBranding } from "../../chassis/src/branding.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

export interface TenantBranding {
  tenant(): string | undefined;
  forRender(): Promise<OrgBranding>;
  refreshNow(): Promise<void>;
}

export function createTenantBranding(
  fetchBranding: () => Promise<OrgBranding>,
  currentToken: () => string | undefined,
  identitySecret: string | undefined,
): TenantBranding {
  const caches = new Map<string, BrandingCache>([["", createBrandingCache(fetchBranding)]]);
  const tenant = (): string | undefined => {
    const token = currentToken();
    return token && identitySecret ? verifyPortalIdentity(token, identitySecret, Date.now())?.t : undefined;
  };
  const cache = (): BrandingCache => {
    const key = tenant() ?? "";
    let found = caches.get(key);
    if (!found) {
      found = createBrandingCache(fetchBranding);
      caches.set(key, found);
    }
    return found;
  };
  return { tenant, forRender: () => cache().forRender(), refreshNow: () => cache().refreshNow() };
}

export function brandingFrom(text: string): OrgBranding {
  const b = (JSON.parse(text) as { branding?: Record<string, unknown> }).branding;
  return Object.fromEntries(
    (["orgName", "accent", "mark", "markUrl", "selfLabel"] as const).flatMap((key) =>
      typeof b?.[key] === "string" ? [[key, b[key]]] : [],
    ),
  ) as OrgBranding;
}
