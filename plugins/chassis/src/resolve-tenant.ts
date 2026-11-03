import type { IncomingMessage, ServerResponse } from "node:http";
import { withTenant } from "./tenant.ts";

export type TenantResolver = (req: IncomingMessage) => Promise<string | undefined>;

let resolver: TenantResolver = async () => undefined;

export function setTenantResolver(next: TenantResolver): void {
  resolver = next;
}

export function resolveTenant(req: IncomingMessage): Promise<string | undefined> {
  return resolver(req);
}

export async function inResolvedTenant(
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && (path === "/healthz" || path === "/readyz")) return handle();
  const tenant = await resolveTenant(req);
  if (tenant) return withTenant(tenant, handle);
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "tenant_unresolved", message: "this host does not belong to a known tenant" }));
  req.resume();
}
