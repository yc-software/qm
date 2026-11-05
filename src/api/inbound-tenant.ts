import type { IncomingMessage } from "node:http";
import { withTenant } from "../tenants/context.ts";
import { inTenant, type TenantKey, type TenantLookup } from "../tenants/lookup.ts";
import type { KeyedTenant, Route } from "./routes/route.ts";

export const EMPTY_TENANT = "00000000-0000-0000-0000-000000000000";

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

function appHostSlug(host: string | undefined, appsDomain: string | undefined): string | undefined {
  if (!appsDomain) return undefined;
  const bare = (host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : undefined;
}

export function inboundKey(
  req: IncomingMessage,
  gate: { deployAppsDomain?: string; deployGateSecret?: string },
  found: { route: Pick<Route, "tenant">; params: Record<string, string> } | null,
  url: URL,
): InboundKey | undefined {
  const slug = gate.deployGateSecret ? appHostSlug(req.headers.host, gate.deployAppsDomain) : undefined;
  if (slug !== undefined) return { by: "deployment", key: slug };
  const keyed = found?.route.tenant;
  if (typeof keyed !== "object") return undefined;
  const key = { by: keyed.by, key: keyed.key(found!.params, url) };
  return keyed.signedTenantFirst ? { ...key, signedTenantFirst: true } : key;
}

export async function withInboundTenant(
  lookup: Pick<TenantLookup, "tenantFor">,
  inbound: InboundKey,
  next: () => Promise<void>,
  signedTenant?: () => Promise<string | undefined>,
): Promise<void> {
  const signed = inbound.signedTenantFirst ? await signedTenant?.() : undefined;
  const tenant = signed ?? (await lookup.tenantFor(inbound.by, inbound.key));
  return tenant ? inTenant(tenant, next) : withTenant(EMPTY_TENANT, next);
}
