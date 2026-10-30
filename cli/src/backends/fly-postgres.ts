import {
  APP_LOGIN,
  DATABASE_LOGIN_ENV_NAMES,
  READER_LOGIN,
  databaseLoginEnv,
  type DatabaseLoginEnv,
} from "../database-logins.ts";
import { CliError, note } from "../log.ts";
import { fly, flySensitive, secretNames, stageSecret } from "./fly-cli.ts";

export interface FlyPostgresTarget {
  appPrefix: string;
  flyOrg: string;
  region: string;
  ownerUrl?: string;
}

export function mpgClusterId(listOutput: string, name: string): string | undefined {
  return listOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields.includes(name))?.[0];
}

export function mpgDirectUrl(statusOutput: string, clusterId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusOutput);
  } catch {
    throw new CliError("fly mpg status returned invalid JSON");
  }
  const credentials =
    parsed && typeof parsed === "object"
      ? (parsed as { credentials?: { direct_uri?: unknown; pgbouncer_uri?: unknown } }).credentials
      : undefined;
  const value = credentials?.direct_uri ?? credentials?.pgbouncer_uri;
  if (typeof value !== "string" || !value) {
    throw new CliError("fly mpg status did not return a database connection URI");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("fly mpg status returned an invalid database connection URI");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new CliError("fly mpg status returned an invalid database connection scheme");
  }
  const pooledHost = `pgbouncer.${clusterId}.flympg.net`;
  const directHost = `direct.${clusterId}.flympg.net`;
  if (url.hostname === pooledHost) {
    url.hostname = directHost;
  } else if (url.hostname !== directHost) {
    throw new CliError("fly mpg status returned an unrecognized database hostname");
  }
  return url.toString();
}

export function mpgClusterOfUrl(databaseUrl: string): string | undefined {
  return /^direct\.([a-z0-9-]+)\.flympg\.net$/.exec(new URL(databaseUrl).hostname)?.[1];
}

function managedCluster(target: FlyPostgresTarget): string {
  const pgName = `${target.appPrefix}-pg`;
  const existing = mpgClusterId(fly(["mpg", "list", "--org", target.flyOrg]), pgName);
  if (existing) return existing;
  note(`postgres: creating cluster ${pgName} (basic plan)…`);
  const created = fly([
    "mpg",
    "create",
    "--org",
    target.flyOrg,
    "--region",
    target.region,
    "--name",
    pgName,
    "--plan",
    "basic",
  ]);
  const id = created.match(/ID:\s*(\S+)/)?.[1];
  if (!id) throw new CliError(`could not parse cluster id from mpg create output:\n${created}`);
  return id;
}

function jsonField(value: unknown, ...names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const found = names.map((name) => (value as Record<string, unknown>)[name]).find((v) => typeof v === "string");
  return found as string | undefined;
}

function mpgLoginPassword(clusterId: string, login: string, role: "writer" | "reader"): string {
  let users: unknown;
  try {
    users = JSON.parse(fly(["mpg", "users", "list", clusterId, "--json"]) || "[]");
  } catch {
    throw new CliError("fly mpg users list returned invalid JSON");
  }
  const exists = Array.isArray(users) && users.some((user) => jsonField(user, "name", "username", "Name") === login);
  if (!exists) {
    fly(["mpg", "users", "create", clusterId, "--username", login, "--role", role]);
    note(`postgres: created ${role} login ${login}`);
  }
  const rotated = flySensitive(
    ["mpg", "users", "rotate-password", clusterId, "--username", login, "--yes", "--json"],
    `failed to set the Managed Postgres password for ${login}`,
  );
  let password: string | undefined;
  try {
    password = jsonField(JSON.parse(rotated), "password", "Password");
  } catch {
    password = undefined;
  }
  if (!password) throw new CliError(`fly mpg users rotate-password returned no password for ${login}`);
  return password;
}

export function flyDatabaseLogins(
  target: FlyPostgresTarget,
  existing: ReadonlySet<string> | undefined,
): DatabaseLoginEnv {
  let ownerUrl = target.ownerUrl;
  if (!ownerUrl) {
    if (existing?.has("DATABASE_URL")) {
      throw new CliError(
        `${target.appPrefix}-core has a DATABASE_URL from before the runtime and owner database logins were split. ` +
          `Put that URL (the login that owns the tables) in .env as DATABASE_OWNER_URL and run qm up again; ` +
          `for the managed cluster ${target.appPrefix}-pg it is the direct_uri from \`fly mpg status <cluster> --json\``,
      );
    }
    const id = managedCluster(target);
    ownerUrl = mpgDirectUrl(
      flySensitive(["mpg", "status", id, "--json"], "failed to read Managed Postgres connection details"),
      id,
    );
  }
  const clusterId = mpgClusterOfUrl(ownerUrl);
  if (!clusterId) return databaseLoginEnv(ownerUrl);
  return databaseLoginEnv(ownerUrl, {
    app: mpgLoginPassword(clusterId, APP_LOGIN, "writer"),
    reader: mpgLoginPassword(clusterId, READER_LOGIN, "reader"),
  });
}

export function ensureFlyPostgres(target: FlyPostgresTarget, apps: readonly string[]): void {
  const existing = new Map(apps.map((app) => [app, secretNames(app)]));
  if (apps.every((app) => DATABASE_LOGIN_ENV_NAMES.every((name) => existing.get(app)?.has(name)))) {
    note(`postgres: database logins already set on ${apps.join(", ")}`);
    return;
  }
  const logins = flyDatabaseLogins(target, existing.get(`${target.appPrefix}-core`));
  for (const app of apps) for (const [name, value] of Object.entries(logins)) stageSecret(app, name, value);
  note(`postgres: owner, qm_app and qm_reader connections staged on ${apps.join(", ")}`);
}
