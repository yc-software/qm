import type { PgPool } from "../persistence/pg-pool.ts";
import { withTenant } from "./context.ts";

export function bootTenantReader(db: Pick<PgPool, "q">): () => Promise<string | undefined> {
  let read: Promise<string | undefined> | undefined;
  return () =>
    (read ??= db.q("SELECT id::text AS id FROM tenants LIMIT 2").then(
      (rows) => (rows.length === 1 ? (rows[0]!.id as string) : undefined),
      (error: unknown) => {
        read = undefined;
        throw error;
      },
    ));
}

export function inBootTenant<T>(tenant: string | undefined, fn: () => T): T {
  return tenant ? withTenant(tenant, fn) : fn();
}
