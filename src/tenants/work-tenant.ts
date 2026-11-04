import type { PgPool } from "../persistence/pg-pool.ts";
import { boundTenant, registerTenants } from "./context.ts";

const TENANT_RECHECK_MS = 5_000;

let checked: { at: number; done: Promise<void> } | undefined;
let sole: string | undefined;

const missingTable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "42P01";

async function readTenants(pg: Pick<PgPool, "q">): Promise<void> {
  const [soleRows, installRows] = await Promise.all([
    pg.q("SELECT sole::text AS id FROM qm_sole_tenant()"),
    pg.q("SELECT id::text AS id FROM qm_tenant").catch((error: unknown) => {
      if (missingTable(error)) return [];
      throw error;
    }),
  ]);
  const idOf = (rows: Record<string, unknown>[]): string | undefined =>
    rows[0]?.id == null ? undefined : String(rows[0].id);
  sole = idOf(soleRows);
  const install = idOf(installRows);
  if (install !== undefined) registerTenants(install, sole);
}

export function refreshTenants(pg: Pick<PgPool, "q">): Promise<void> {
  const done = readTenants(pg);
  const entry = { at: Date.now(), done };
  checked = entry;
  done.catch(() => {
    if (checked === entry) checked = undefined;
  });
  return done;
}

export function watchTenants(pg: Pick<PgPool, "q">, onError: (error: unknown) => void): () => void {
  const timer = setInterval(() => void refreshTenants(pg).catch(onError), TENANT_RECHECK_MS);
  timer.unref();
  void refreshTenants(pg).catch(onError);
  return () => clearInterval(timer);
}

export async function workTenant(pg: Pick<PgPool, "q">): Promise<string> {
  const bound = boundTenant();
  if (bound !== undefined) return bound;
  if (!checked || Date.now() - checked.at > TENANT_RECHECK_MS) void refreshTenants(pg).catch(() => undefined);
  await checked?.done;
  const tenant = sole;
  if (tenant === undefined) throw new Error("No tenant is bound to this work");
  return tenant;
}
