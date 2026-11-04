import type { IncomingMessage, ServerResponse } from "node:http";
import { expiringCache } from "./expiring-cache.ts";
import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { withTenant } from "./tenant.ts";

export interface HostTenant {
  tenant?: string;
  multi: boolean;
  sole?: boolean;
}

export type HostTenantLookup = (host: string) => Promise<HostTenant>;

const PROBES = new Set(["/healthz", "/readyz"]);

export function coreHostTenants(core: string, secret: string | undefined): HostTenantLookup {
  const cache = expiringCache<HostTenant>(1000, 30_000);
  return async (host) => {
    const cached = cache.get(host);
    if (cached) return cached;
    const path = withSourceAuthNonce(`/v1/operator/hosts/${encodeURIComponent(host)}`, secret);
    const r = await fetch(`${core}${path}`, {
      headers: signedHeaders(secret, "GET", path),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 404) return { multi: false };
    if (!r.ok) throw new Error(`core refused the host tenant lookup: HTTP ${r.status}`);
    const body = (await r.json()) as { tenant?: unknown; multi?: unknown; sole?: unknown };
    const found = {
      ...(typeof body.tenant === "string" ? { tenant: body.tenant } : {}),
      multi: body.multi === true,
      sole: body.sole === true,
    };
    cache.set(host, found);
    return found;
  };
}

export function requestHostname(req: IncomingMessage): string {
  return (req.headers.host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export async function inHostTenant(
  lookup: HostTenantLookup | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
  refuseUnknown = true,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (!lookup || PROBES.has(path)) return handle();
  const found = await lookup(requestHostname(req)).catch(() => undefined);
  if (!found) {
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "tenant_lookup_failed", message: "could not resolve this host's tenant" }));
    return;
  }
  if (found.tenant) return withTenant(found.tenant, handle);
  if (!found.multi || !refuseUnknown) return handle();
  req.resume();
  res.writeHead(421, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unknown_host", message: "this host does not belong to a known tenant" }));
}
