import { deploymentGitToken } from "../deploy/access-token.ts";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { runWithTenant, type TenantContext } from "./context.ts";
import { tenantHost } from "./manifest.ts";
import { routingTokenTenant } from "../auth/capability-token.ts";

export interface TenantIngress {
  context: TenantContext;
  hosts: readonly string[];
  appsDomain?: string;
  listener: RequestListener;
}

function capabilityTenant(req: IncomingMessage): string | undefined {
  let token = req.headers["x-agent-capability"];
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://core.local");
  } catch {
    return undefined;
  }
  if (!token && /^\/v1\/deployments\/[^/]+\/git\//.test(url.pathname)) {
    token = deploymentGitToken(req.headers.authorization, url) ?? undefined;
  }
  return routingTokenTenant(typeof token === "string" ? token : null) ?? undefined;
}

export function createTenantRouter(tenants: readonly TenantIngress[], pooled: boolean): RequestListener {
  const ids = new Map(tenants.map((tenant) => [tenant.context.id, tenant]));
  const hosts = new Map(tenants.flatMap((tenant) => tenant.hosts.map((host) => [host, tenant] as const)));
  if (ids.size !== tenants.length || hosts.size !== tenants.reduce((total, tenant) => total + tenant.hosts.length, 0))
    throw new Error("Tenant ingress has duplicate identifiers or hosts");
  if (!pooled && tenants.length !== 1) throw new Error("Dedicated ingress requires exactly one tenant");
  return (req, res) => {
    const reject = (status: number, error: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
    };
    if (!pooled) return runWithTenant(tenants[0]!.context, () => tenants[0]!.listener(req, res));
    const selector = req.headers["x-qm-tenant"];
    if (selector !== undefined && (typeof selector !== "string" || !ids.has(selector)))
      return reject(421, "unknown_tenant");
    let host: string;
    try {
      host = tenantHost(req.headers.host ?? "");
    } catch {
      return reject(400, "invalid_host");
    }
    let fromHost = hosts.get(host);
    const hostname = host.split(":")[0]!;
    const apps = tenants.filter((tenant) => tenant.appsDomain && hostname.endsWith(`.${tenant.appsDomain}`));
    if (apps.length > 1 || (fromHost && apps.some((tenant) => tenant !== fromHost)))
      return reject(421, "ambiguous_tenant");
    fromHost ??= apps[0];
    const fromHeader = typeof selector === "string" ? ids.get(selector) : undefined;
    if (fromHost && fromHeader && fromHost !== fromHeader) return reject(421, "conflicting_tenant");
    const capabilityId = capabilityTenant(req);
    const fromCapability = capabilityId === undefined ? undefined : ids.get(capabilityId);
    if (capabilityId !== undefined && !fromCapability) return reject(421, "unknown_tenant");
    if (fromCapability && ((fromHost && fromHost !== fromCapability) || (fromHeader && fromHeader !== fromCapability)))
      return reject(421, "conflicting_tenant");
    const tenant = fromHost ?? fromHeader ?? fromCapability;
    if (!tenant) {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      return reject(421, "unknown_tenant");
    }
    runWithTenant(tenant.context, () => tenant.listener(req, res));
  };
}

export function createHostServer(listener: RequestListener): Server {
  const server = createServer(listener);
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1024;
  return server;
}
