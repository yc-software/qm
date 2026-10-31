import { join } from "node:path";
import { derivedLoginPassword } from "../../../cli/src/database-logins.ts";
import { operatorInit } from "../../../cli/src/operator-request.ts";
import { isTenantSetting } from "../../../cli/src/tenant-setting-names.ts";
import { ensureInstallTenant } from "../../../src/tenants/install.ts";
import { envFileGet } from "../lib/envctx.ts";
import { adminGrantCount, checkPostgres, ensureLocalPostgres, firstAdminPrincipal } from "../lib/postgres.ts";
import { errMessage } from "../lib/util.ts";

type Phase = (name: string, state: "start" | "ok" | "warn" | "fail", detail?: string) => void;

export interface Durability {
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
  const envFile = join(worktree, ".env");
  let databaseUrl =
    env.DATABASE_OWNER_URL ||
    envFileGet(envFile, "DATABASE_OWNER_URL") ||
    env.DATABASE_URL ||
    envFileGet(envFile, "DATABASE_URL");
  let adminGrantsSeed = env.ADMIN_GRANTS || envFileGet(envFile, "ADMIN_GRANTS");
  let localPg = false;
  if (!databaseUrl) {
    try {
      const pg = await ensureLocalPostgres(worktree, log);
      databaseUrl = pg.url;
      localPg = true;
    } catch (err) {
      throw new Error(
        `DATABASE_URL is required and local Docker Postgres could not be started (${errMessage(err)}). Export DATABASE_URL or add it to ${liveEnvFile} or .env.`,
        { cause: err },
      );
    }
  }
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
  const durableAdminPrincipal = await firstAdminPrincipal(worktree, databaseUrl).catch(() => "");
  phase("durability", "ok", `Postgres (${grants} durable grant(s))`);
  return { databaseUrl, adminGrantsSeed, durableAdminPrincipal };
}

export async function prepareDevTenant(
  inputs: { databaseUrl: string; adminGrantsSeed: string; baseEnv: Record<string, string>; ports: { core: number } },
  phase: Phase,
): Promise<void> {
  phase("tenant", "start");
  const { tenant, created } = await ensureInstallTenant(inputs.databaseUrl);
  phase("tenant", "ok", `${created ? "created" : "using"} install tenant ${tenant}`);
  const env = Object.fromEntries(
    Object.entries(inputs.baseEnv).filter(([name, value]) => value.trim() && isTenantSetting(name)),
  );
  if (inputs.adminGrantsSeed) env.ADMIN_GRANTS = inputs.adminGrantsSeed;
  if (!Object.keys(env).length) return;
  const path = "/v1/tenant-settings";
  const credentials = {
    signing: inputs.baseEnv.CORE_SIGNING_SECRET ?? "",
    control: inputs.baseEnv.DEPLOYMENT_CONTROL_SECRET ?? "",
  };
  const response = await fetch(
    `http://127.0.0.1:${inputs.ports.core}${path}`,
    operatorInit(credentials, "PUT", path, JSON.stringify({ env })),
  );
  if (response.status === 404) throw new Error("tenant settings: this core has no PUT /v1/tenant-settings route");
  if (!response.ok) throw new Error(`tenant settings: ${response.status} ${await response.text()}`);
  phase("tenant", "ok", `wrote ${Object.keys(env).sort().join(", ")} to the install tenant`);
}

export function devDatabaseEnv(ownerUrl: string): Record<string, string> {
  const owner = new URL(ownerUrl);
  const secret = decodeURIComponent(owner.password) || ownerUrl;
  const login = (name: string): string => {
    const url = new URL(ownerUrl);
    url.username = name;
    url.password = derivedLoginPassword(secret, name);
    return url.toString();
  };
  return { DATABASE_OWNER_URL: ownerUrl, DATABASE_URL: login("qm_app"), DATABASE_READER_URL: login("qm_reader") };
}
