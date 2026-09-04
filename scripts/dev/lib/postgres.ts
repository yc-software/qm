import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { run } from "./proc.ts";
import { sleep } from "./util.ts";

const POSTGRES_IMAGE = "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";

function docker(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("docker", args, { input: opts.input, timeoutMs: opts.timeoutMs ?? 120_000 });
}

export async function ensureDockerDaemon(log: (msg: string) => void): Promise<boolean> {
  if ((await run("docker", ["--version"], { timeoutMs: 15_000 })).code !== 0) return false;
  if ((await docker(["info"])).code === 0) return true;
  if ((await run("colima", ["version"], { timeoutMs: 15_000 })).code === 0) {
    log("starting Colima so dev-instance can run local Postgres...");
    await run("colima", ["start"], { timeoutMs: 180_000 });
  }
  return (await docker(["info"])).code === 0;
}

function worktreeDbName(worktree: string): string {
  return `qm_dev_${createHash("sha1").update(worktree).digest("hex").slice(0, 12)}`;
}

async function pgQuery(
  databaseUrl: string,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const pg = (await import("pg")).default;
  const pool: Pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("error", () => {});
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

export const checkPostgres = async (_worktree: string, url: string): Promise<void> => {
  await pgQuery(url, "SELECT 1");
};

export const adminGrantCount = async (_worktree: string, url: string): Promise<number> => {
  const [table] = await pgQuery(url, "SELECT to_regclass($1) AS name", ["public.admin_grants"]);
  if (!table?.name) return 0;
  const [count] = await pgQuery(url, "SELECT COUNT(*)::int AS n FROM admin_grants");
  return Number(count?.n ?? 0);
};

export const firstAdminPrincipal = async (_worktree: string, url: string): Promise<string> => {
  const [table] = await pgQuery(url, "SELECT to_regclass($1) AS name", ["public.admin_grants"]);
  if (!table?.name) return "";
  const [row] = await pgQuery(
    url,
    "SELECT principal_id FROM admin_grants WHERE role = $1 ORDER BY created_at NULLS LAST, principal_id LIMIT 1",
    ["org_admin"],
  );
  return String(row?.principal_id ?? "");
};

export interface LocalPostgres {
  url: string;
}

export async function ensureLocalPostgres(worktree: string, log: (msg: string) => void): Promise<LocalPostgres> {
  const container = process.env.DEV_INSTANCE_POSTGRES_CONTAINER || "qm-dev-postgres";
  const port = process.env.DEV_INSTANCE_POSTGRES_PORT || "55432";
  const image = process.env.DEV_INSTANCE_POSTGRES_IMAGE || POSTGRES_IMAGE;
  const password = process.env.DEV_INSTANCE_POSTGRES_PASSWORD || "qm-dev";
  const volume = process.env.DEV_INSTANCE_POSTGRES_VOLUME || "qm-dev-postgres-data";
  const dbName = worktreeDbName(worktree);

  if (!(await ensureDockerDaemon(log))) throw new Error("docker daemon unavailable");
  const exists = (
    await docker(["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"])
  ).stdout.trim();
  if (!exists) {
    if ((await docker(["volume", "create", volume])).code !== 0) throw new Error("docker volume create failed");
    const result = await docker([
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "-v",
      `${volume}:/var/lib/postgresql/data`,
      image,
    ]);
    if (result.code !== 0) throw new Error(`docker run failed: ${result.stderr.trim()}`);
  } else if ((await docker(["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() !== "true") {
    if ((await docker(["start", container])).code !== 0) throw new Error("docker start failed");
  }

  let ready = false;
  for (let i = 0; i < 60; i++) {
    if ((await docker(["exec", container, "pg_isready", "-U", "postgres"])).code === 0) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) throw new Error(`postgres container ${container} never became ready`);

  const existsDb = (
    await docker([
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "psql",
      "-U",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
      "postgres",
    ])
  ).stdout.trim();
  if (
    existsDb !== "1" &&
    (await docker(["exec", "-e", `PGPASSWORD=${password}`, container, "createdb", "-U", "postgres", dbName])).code !== 0
  ) {
    throw new Error(`createdb ${dbName} failed`);
  }
  log(`durability: using local Postgres container ${container} database ${dbName}`);
  return { url: `postgres://postgres:${password}@127.0.0.1:${port}/${dbName}` };
}
