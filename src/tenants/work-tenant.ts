import type { PgPool } from "../persistence/pg-pool.ts";
import { assertTenancyAllowed, boundTenant, refuseTenancy, registerTenants } from "./context.ts";

const TENANT_RECHECK_MS = 5_000;

let checked: { at: number; done: Promise<void> } | undefined;
let sole: string | undefined;

const missingTable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "42P01";

const BYPASSES_ROW_SECURITY = `SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relrowsecurity AND c.relnamespace = current_schema()::regnamespace AND pg_has_role(c.relowner, 'USAGE')
  ) AS bypass
  FROM pg_roles r WHERE r.rolname = current_user`;

const BYPASS_REFUSAL =
  "Refusing tenant work: the database login owns the tenant tables or bypasses row-level security while more than one tenant exists. Connect as a non-owner login without BYPASSRLS.";

async function readTenants(pg: Pick<PgPool, "pool">): Promise<void> {
  const pool = await pg.pool();
  const [soleRows, installRows, bypassRows] = await Promise.all([
    pool.query("SELECT sole::text AS id, tenants FROM qm_sole_tenant()").then((result) => result.rows),
    pool
      .query("SELECT id::text AS id FROM qm_tenant")
      .then((result) => result.rows)
      .catch((error: unknown) => {
        if (missingTable(error)) return [];
        throw error;
      }),
    pool.query(BYPASSES_ROW_SECURITY).then((result) => result.rows),
  ]);
  const idOf = (rows: Record<string, unknown>[]): string | undefined =>
    rows[0]?.id == null ? undefined : String(rows[0].id);
  refuseTenancy(Number(soleRows[0]?.tenants ?? 0) > 1 && bypassRows[0]?.bypass === true ? BYPASS_REFUSAL : undefined);
  sole = idOf(soleRows);
  const install = idOf(installRows);
  if (install !== undefined) registerTenants(install, sole);
  assertTenancyAllowed();
}

export function refreshTenants(pg: Pick<PgPool, "pool">): Promise<void> {
  const done = readTenants(pg);
  const entry = { at: Date.now(), done };
  checked = entry;
  done.catch(() => {
    if (checked === entry) checked = undefined;
  });
  return done;
}

export async function watchTenants(pg: Pick<PgPool, "pool">, onError: (error: unknown) => void): Promise<() => void> {
  await refreshTenants(pg);
  const timer = setInterval(() => void refreshTenants(pg).catch(onError), TENANT_RECHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function workTenant(pg: Pick<PgPool, "pool">): Promise<string> {
  const bound = boundTenant();
  if (bound !== undefined) return bound;
  if (!checked || Date.now() - checked.at > TENANT_RECHECK_MS) void refreshTenants(pg).catch(() => undefined);
  await checked?.done;
  const tenant = sole;
  if (tenant === undefined) throw new Error("No tenant is bound to this work");
  return tenant;
}
