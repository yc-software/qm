import { edgeTenant } from "./tenant-hosts.ts";
import { deriveTenantSecret } from "./tenant-settings.ts";
export const CORE_API_URL = (process.env.CORE_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const CORE_ORG_ID = process.env.CORE_ORG_ID ?? "acme";
export const coreOrgId = (): string => edgeTenant()?.orgId ?? CORE_ORG_ID;
const secret = (raw: string | undefined): string | undefined => (raw?.trim() ? raw : undefined);

const CORE_SIGNING_SECRET = secret(process.env.CORE_SIGNING_SECRET);
const PORTAL_IDENTITY_SECRET = secret(process.env.PORTAL_IDENTITY_SECRET) ?? CORE_SIGNING_SECRET;
const forServedTenant = (value: string | undefined): string | undefined => {
  const id = edgeTenant()?.id;
  return value && id ? deriveTenantSecret(value, id) : value;
};
export const coreSigningSecret = (): string | undefined => forServedTenant(CORE_SIGNING_SECRET);
export const portalIdentitySecret = (): string | undefined => forServedTenant(PORTAL_IDENTITY_SECRET);
if (!secret(process.env.PORTAL_IDENTITY_SECRET) && CORE_SIGNING_SECRET) {
  console.warn(
    "[chassis] PORTAL_IDENTITY_SECRET unset, signing portal identity with CORE_SIGNING_SECRET (dev fallback)",
  );
}

export function portFromEnv(fallback: number): number {
  return Number(process.env.PORT ?? fallback);
}

export function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate);
}
