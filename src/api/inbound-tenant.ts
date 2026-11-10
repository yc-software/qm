import type { IncomingMessage } from "node:http";
import { inTenant } from "../tenants/claim.ts";
import type { TenantKey, TenantLookup } from "../tenants/lookup.ts";
import type { KeyedTenant, Route } from "./routes/route.ts";
import { labelOfAppHost } from "../tenants/app-handle.ts";

interface InboundKey {
  by: TenantKey;
  key: string | undefined;
  signedTenantFirst?: true;
}

export function firstSegment(prefix: string): KeyedTenant["key"] {
  return (_params, url) => {
    const rest = url.pathname.slice(prefix.length);
    try {
      return decodeURIComponent(rest.split("/")[0]!);
    } catch {
      return undefined;
    }
  };
}

export function inboundKey(
  req: IncomingMessage,
  gate: { deployAppsDomain?: string; deployGateSecret?: string },
  found: { route: Pick<Route, "tenant">; params: Record<string, string> } | null,
  url: URL,
): InboundKey | undefined {
  const slug = gate.deployGateSecret ? labelOfAppHost(req.headers.host, gate.deployAppsDomain) : undefined;
  if (slug !== undefined) return { by: "app_host", key: slug };
  const keyed = found?.route.tenant;
  if (typeof keyed !== "object") return undefined;
  const key = { by: keyed.by, key: keyed.key(found!.params, url) };
  return keyed.signedTenantFirst ? { ...key, signedTenantFirst: true } : key;
}

export async function withInboundTenant(
  lookup: Pick<TenantLookup, "tenantFor">,
  inbound: InboundKey,
  next: () => Promise<void>,
  unknown: () => void,
  signedTenant?: () => Promise<string | undefined>,
): Promise<void> {
  const signed = inbound.signedTenantFirst ? await signedTenant?.() : undefined;
  const tenant = signed ?? (await lookup.tenantFor(inbound.by, inbound.key));
  if (!tenant) return unknown();
  return inTenant(tenant, next);
}
