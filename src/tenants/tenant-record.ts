import { createHash } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";
import { currentTenant } from "./context.ts";

export function composioNamespaceReader(pool: Pick<PgPool, "q"> | null): () => Promise<string> {
  const namespaces = new Map<string, Promise<string>>();
  return () => {
    const tenant = currentTenant();
    if (!pool) return Promise.resolve(tenant);
    let namespace = namespaces.get(tenant);
    if (!namespace) {
      namespace = pool
        .q("SELECT COALESCE(composio_namespace, id::text) AS namespace FROM tenants WHERE id = $1", [tenant])
        .then((rows) => {
          if (!rows[0]) throw new Error("Unknown tenant");
          return String(rows[0].namespace);
        });
      namespaces.set(tenant, namespace);
      namespace.catch(() => namespaces.delete(tenant));
    }
    return namespace;
  };
}

export function tenantNameReader(pool: Pick<PgPool, "q"> | null): () => Promise<string> {
  return async () => {
    const tenant = currentTenant();
    if (!pool) return tenant;
    const rows = await pool.q("SELECT name FROM tenants WHERE id = $1", [tenant]);
    if (!rows[0]) throw new Error("Unknown tenant");
    return String(rows[0].name);
  };
}

export function composioUserId(namespace: string, principal: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([namespace, principal]))
    .digest("hex")}`;
}
