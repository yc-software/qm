import { join } from "node:path";
import { operatorInit } from "../../../cli/src/operator-request.ts";
import { isTenantSetting } from "../../../cli/src/tenant-setting-names.ts";
import { applyTenantImport, tenantImport, type OperatorCall } from "../../../cli/src/tenant-import.ts";
import { envFileGet } from "../lib/envctx.ts";
import { adminGrantCount, checkPostgres, ensureLocalPostgres, firstAdminPrincipal } from "../lib/postgres.ts";
import { run } from "../lib/proc.ts";
import type { ChildSpec } from "../lib/types.ts";
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
  const durableAdminPrincipal = await firstAdminPrincipal(worktree, databaseUrl).catch((err) => {
    phase("durability", "warn", `could not read the first durable admin principal: ${errMessage(err)}`);
    return "";
  });
  phase("durability", "ok", `Postgres (${grants} durable grant(s))`);
  return { databaseUrl, adminGrantsSeed, durableAdminPrincipal };
}

export async function prepareDevTenant(
  inputs: { adminGrantsSeed: string; baseEnv: Record<string, string>; ports: { core: number } },
  phase: Phase,
): Promise<void> {
  phase("tenant", "start");
  const env = Object.fromEntries(
    Object.entries(inputs.baseEnv).filter(([name, value]) => value.trim() && isTenantSetting(name)),
  );
  if (inputs.adminGrantsSeed) env.ADMIN_GRANTS = inputs.adminGrantsSeed;
  const credentials = {
    signing: inputs.baseEnv.CORE_SIGNING_SECRET ?? "",
    control: inputs.baseEnv.DEPLOYMENT_CONTROL_SECRET ?? "",
  };
  const call: OperatorCall = async (path, body, tenant) => {
    const text = JSON.stringify(body);
    const response = await fetch(
      `http://127.0.0.1:${inputs.ports.core}${path}`,
      operatorInit(credentials, "PUT", path, text, tenant),
    );
    return { status: response.status, body: await response.text() };
  };
  const { tenant, applied } = await applyTenantImport(tenantImport(env), call, (message) =>
    phase("tenant", "warn", message),
  ).catch((error) => {
    throw new Error(`tenant settings: ${errMessage(error)}`, { cause: error });
  });
  phase("tenant", "ok", `wrote ${applied.join(", ") || "nothing new"} to the install tenant ${tenant}`);
}

export async function runDatabaseRelease(spec: ChildSpec, phase: Phase): Promise<void> {
  phase("database", "start");
  const result = await run("node", ["--env-file-if-exists=.env", "src/migrate-main.ts"], {
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: 300_000,
  });
  if (result.code !== 0)
    throw new Error(`database migrations and logins failed: ${(result.stderr || result.stdout).trim()}`);
  phase("database", "ok", result.stdout.trim().split("\n").at(-1));
}
