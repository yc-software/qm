import type { PgPool } from "../persistence/pg-pool.ts";
import { memoryTenants } from "./resolver.ts";

export type RowTenants = (table: string, columns: readonly string[], value: string) => Promise<string[]>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function ownerRowTenants(owner: Pick<PgPool, "q">): RowTenants {
  return async (table, columns, value) => {
    if (!IDENTIFIER.test(table) || !columns.length || !columns.every((column) => IDENTIFIER.test(column)))
      throw new Error(`Invalid row reference ${table}(${columns.join(", ")})`);
    const match = columns.map((column) => `${column} = $1`).join(" OR ");
    const rows = await owner.q(`SELECT DISTINCT tenant_id::text AS tenant FROM ${table} WHERE ${match}`, [value]);
    return rows.map((row) => String(row.tenant));
  };
}

export const memoryRowTenants: RowTenants = () => memoryTenants();
