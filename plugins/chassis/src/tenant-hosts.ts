import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantSettings } from "./tenant-settings.ts";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

const HEALTH_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

export interface HostRoute<T> {
  hosts: readonly string[];
  appsDomain?: string;
  target: T;
}

export function tenantPublicUrl(tenant: TenantSettings): string {
  return `https://${tenant.hosts[0] ?? ""}`;
}

const servingTenant = new AsyncLocalStorage<TenantSettings>();
let edgeTenants: readonly TenantSettings[] = [];
let edgeRoutes: HostRoute<TenantSettings>[] = [];
const edgeTenantListeners = new Set<(tenants: readonly TenantSettings[]) => void>();

export function setEdgeTenants(tenants: readonly TenantSettings[]): void {
  edgeTenants = tenants;
  edgeRoutes = tenants.map((t) => ({
    hosts: t.hosts,
    ...(t.appsDomain ? { appsDomain: t.appsDomain } : {}),
    target: t,
  }));
  for (const listener of edgeTenantListeners) listener(tenants);
}

export function onEdgeTenants(listener: (tenants: readonly TenantSettings[]) => void): void {
  edgeTenantListeners.add(listener);
  listener(edgeTenants);
}

export function edgeTenant(): TenantSettings | undefined {
  return servingTenant.getStore();
}

export function withEdgeTenant<T>(tenant: TenantSettings | undefined, fn: () => T): T {
  return tenant ? servingTenant.run(tenant, fn) : fn();
}

export function perEdgeTenant<T>(create: () => T): () => T {
  const states = new Map<string, T>([["", create()]]);
  return () => {
    const key = edgeTenant()?.id ?? "";
    let state = states.get(key);
    if (state === undefined) {
      state = create();
      states.set(key, state);
    }
    return state;
  };
}

export function serveForHost(req: IncomingMessage, res: ServerResponse, handle: () => void): void {
  if (!edgeTenants.length) return handle();
  const tenant =
    routeForHost(edgeRoutes, requestHost(req.headers)) ??
    (HEALTH_PATHS.has(pathOf(req)) ? edgeTenants.find((t) => !t.id) : undefined);
  if (!tenant) return void res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("unknown host\n");
  servingTenant.run(tenant, handle);
}

export function coreTenantHost(): Record<string, string> {
  const host = edgeTenant()?.hosts[0];
  return host ? { "x-forwarded-host": host } : {};
}

export function normalizeHost(raw: string | undefined): string | undefined {
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  if (!first) return undefined;
  if (first.startsWith("[")) return first.slice(0, first.indexOf("]") + 1) || undefined;
  return first.replace(/:\d+$/, "").replace(/\.$/, "") || undefined;
}

export function requestHost(headers: IncomingHttpHeaders): string | undefined {
  const forwarded = headers["x-forwarded-host"];
  return normalizeHost(Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? normalizeHost(headers.host);
}

export function hostOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return undefined;
  }
}

export function routeForHost<T>(routes: readonly HostRoute<T>[], host: string | undefined): T | undefined {
  if (!host) return undefined;
  for (const route of routes) if (route.hosts.some((h) => normalizeHost(h) === host)) return route.target;
  for (const route of routes) {
    const apps = normalizeHost(route.appsDomain);
    if (apps && (host === apps || host.endsWith(`.${apps}`))) return route.target;
  }
  return undefined;
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}
