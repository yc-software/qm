import { join } from "node:path";
import { ensureInstallTenant } from "../../../src/tenants/install.ts";
import { envFileGet } from "../lib/envctx.ts";
import { adminGrantCount, checkPostgres, ensureLocalPostgres, firstAdminPrincipal } from "../lib/postgres.ts";
import { errMessage } from "../lib/util.ts";

type Phase = (name: string, state: "start" | "ok" | "warn" | "fail", detail?: string) => void;

export interface Durability {
  sessionStore: string;
  runStore: string;
  databaseUrl: string;
  adminGrantsSeed: string;
  durableAdminPrincipal: string;
}

export async function prepareDurability(opts: {
  worktree: string;
  env: Record<string, string | undefined>;
  liveEnvFile: string;
  log: (msg: string) => void;
  phase: Phase;
}): Promise<Durability> {
  const { worktree, env, liveEnvFile, log, phase } = opts;
  phase("durability", "start");
  let databaseUrl = env.DATABASE_URL || envFileGet(join(worktree, ".env"), "DATABASE_URL");
  let adminGrantsSeed = env.ADMIN_GRANTS || envFileGet(join(worktree, ".env"), "ADMIN_GRANTS");
  let sessionStore = "memory";
  let runStore = "memory";
  let localPg = false;
  let durableAdminPrincipal = "";
  if (!databaseUrl) {
    try {
      const pg = await ensureLocalPostgres(worktree, log);
      databaseUrl = pg.url;
      localPg = true;
    } catch (err) {
      if (env.DEV_INSTANCE_ALLOW_MEMORY === "1") {
        phase("durability", "warn", "memory stores explicitly allowed by DEV_INSTANCE_ALLOW_MEMORY=1");
      } else {
        throw new Error(
          `DATABASE_URL is required and local Docker Postgres could not be started (${errMessage(err)}). Export DATABASE_URL, add it to ${liveEnvFile} or .env, or set DEV_INSTANCE_ALLOW_MEMORY=1 for a deliberate ephemeral wiring check.`,
          { cause: err },
        );
      }
    }
  }
  if (databaseUrl) {
    sessionStore = "postgres";
    runStore = "postgres";
    await checkPostgres(worktree, databaseUrl).catch((err) => {
      throw new Error(`could not connect to DATABASE_URL: ${errMessage(err)}`, { cause: err });
    });
    const grants = await adminGrantCount(worktree, databaseUrl);
    if (grants === 0 && !adminGrantsSeed) {
      if (localPg) {
        const principal = env.DEV_INSTANCE_ADMIN_PRINCIPAL || env.USER || "dev-admin";
        adminGrantsSeed = `${principal}:org_admin`;
        log(`admin grants: local Postgres will seed ${principal}:org_admin if the store is empty`);
      } else {
        throw new Error(
          "Postgres has no existing admin grants and ADMIN_GRANTS is unset. Set ADMIN_GRANTS=<principal>:org_admin for the first boot of this dev DB, or point DATABASE_URL at a DB that already has admin_grants.",
        );
      }
    }
    durableAdminPrincipal = await firstAdminPrincipal(worktree, databaseUrl).catch(() => "");
    phase("durability", "ok", `SESSION_STORE=postgres RUN_STORE=postgres (${grants} durable grant(s))`);
  } else {
    phase("durability", "ok", "memory stores");
  }
  return { sessionStore, runStore, databaseUrl, adminGrantsSeed, durableAdminPrincipal };
}

export async function ensureDevInstallTenant(databaseUrl: string, phase: Phase): Promise<void> {
  phase("tenant", "start");
  const { tenant, created } = await ensureInstallTenant(databaseUrl);
  phase("tenant", "ok", `${created ? "created" : "using"} install tenant ${tenant}`);
}
