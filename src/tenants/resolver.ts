import { randomUUID } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";

export type TenantList = () => Promise<string[]>;

export function pgTenants(pool: Pick<PgPool, "q">): TenantList {
  return async () => (await pool.q("SELECT id::text AS id FROM tenants ORDER BY id")).map((row) => String(row.id));
}

const processTenant = randomUUID();

export const memoryTenants: TenantList = async () => [processTenant];
