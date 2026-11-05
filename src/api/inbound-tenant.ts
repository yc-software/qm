import type { IncomingMessage, ServerResponse } from "node:http";
import { inTenant, type TenantKey, type TenantLookup } from "../tenants/lookup.ts";
import { sendJson } from "./http.ts";
import type { KeyedTenant, Route } from "./routes/route.ts";

interface InboundKey {
  by: TenantKey;
  key: string;
  unknown?: KeyedTenant["unknown"];
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
  return {
    by: keyed.by,
    key: keyed.key(found!.params, url) ?? "",
    ...(keyed.unknown ? { unknown: keyed.unknown } : {}),
  };
}

export async function withInboundTenant(
  req: IncomingMessage,
  res: ServerResponse,
  lookup: Pick<TenantLookup, "tenantFor">,
  inbound: InboundKey,
  next: () => Promise<void>,
): Promise<void> {
  const tenant = await lookup.tenantFor(inbound.by, inbound.key);
  if (tenant) return inTenant(tenant, next);
  req.resume();
  if (inbound.unknown) return inbound.unknown(res, inbound.key);
  sendJson(res, 404, { error: "not_found" });
}
