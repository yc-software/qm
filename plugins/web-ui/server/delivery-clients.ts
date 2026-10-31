import type { ServerResponse } from "node:http";
import { currentTenant } from "../../../src/tenants/context.ts";

const clients = new Map<string, Map<string, Set<ServerResponse>>>();

function tenantClients(tenant: unknown): Map<string, Set<ServerResponse>> | undefined {
  return typeof tenant === "string" ? clients.get(tenant.toLowerCase()) : undefined;
}

export function addDeliveryClient(user: string, res: ServerResponse): () => void {
  const tenant = currentTenant();
  const byUser = clients.get(tenant) ?? new Map<string, Set<ServerResponse>>();
  clients.set(tenant, byUser);
  const set = byUser.get(user) ?? new Set<ServerResponse>();
  byUser.set(user, set);
  set.add(res);
  return () => {
    set.delete(res);
    if (!set.size && byUser.get(user) === set) byUser.delete(user);
    if (!byUser.size && clients.get(tenant) === byUser) clients.delete(tenant);
  };
}

export function deliveryClientsOf(tenant: unknown, user: string): ReadonlySet<ServerResponse> {
  return tenantClients(tenant)?.get(user) ?? new Set();
}

export function connectedUsers(tenant: unknown): string[] {
  return [...(tenantClients(tenant)?.keys() ?? [])];
}

export function everyDeliveryClient(): ServerResponse[] {
  return [...clients.values()].flatMap((byUser) => [...byUser.values()].flatMap((set) => [...set]));
}
