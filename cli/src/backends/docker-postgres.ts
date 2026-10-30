import { spawnSync } from "node:child_process";
import { DATABASE_LOGIN_ENV_NAMES, OWNER_LOGIN, derivedLoginPassword, loginUrl } from "../database-logins.ts";
import { CliError } from "../log.ts";
import { capture, readEnvFile } from "../util.ts";
import { scramVerifier } from "../scram-verifier.ts";

const NON_SYSTEM = (column: string): string => `${column} NOT LIKE 'pg\\_%' AND ${column} <> 'information_schema'`;

export function dockerOwnerBootstrapSql(ownerPassword: string): string {
  return [
    `DO $$ BEGIN CREATE ROLE ${OWNER_LOGIN} LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    `ALTER ROLE ${OWNER_LOGIN} WITH LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS PASSWORD '${scramVerifier(ownerPassword)}';`,
    `CREATE EXTENSION IF NOT EXISTS vector;`,
    `ALTER DATABASE qm OWNER TO ${OWNER_LOGIN};`,
    `DO $$ DECLARE r record; BEGIN`,
    `  FOR r IN SELECT format('ALTER SCHEMA %I OWNER TO ${OWNER_LOGIN}', nspname) AS ddl FROM pg_namespace`,
    `    WHERE nspowner = 'postgres'::regrole AND ${NON_SYSTEM("nspname")} LOOP EXECUTE r.ddl; END LOOP;`,
    `  FOR r IN SELECT format('ALTER %s %s OWNER TO ${OWNER_LOGIN}', CASE c.relkind WHEN 'v' THEN 'VIEW'`,
    `      WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,`,
    `      c.oid::regclass) AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `    WHERE c.relowner = 'postgres'::regrole AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${NON_SYSTEM("n.nspname")}`,
    `      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid`,
    `        AND (d.deptype = 'e' OR (c.relkind = 'S' AND d.deptype IN ('a', 'i'))))`,
    `    ORDER BY c.relkind = 'S' LOOP EXECUTE r.ddl; END LOOP;`,
    `  FOR r IN SELECT format('ALTER ROUTINE %s OWNER TO ${OWNER_LOGIN}', p.oid::regprocedure) AS ddl FROM pg_proc p`,
    `    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = 'postgres'::regrole AND ${NON_SYSTEM("n.nspname")}`,
    `      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid`,
    `        AND d.deptype = 'e') LOOP EXECUTE r.ddl; END LOOP;`,
    `  FOR r IN SELECT format('ALTER TYPE %s OWNER TO ${OWNER_LOGIN}', t.oid::regtype) AS ddl FROM pg_type t`,
    `    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typowner = 'postgres'::regrole`,
    `      AND t.typtype IN ('e', 'd', 'r') AND ${NON_SYSTEM("n.nspname")}`,
    `      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid`,
    `        AND d.deptype IN ('e', 'i')) LOOP EXECUTE r.ddl; END LOOP;`,
    `END $$;`,
    "",
  ].join("\n");
}

export const managedDockerOwnerUrl = (superuserPassword: string): string =>
  loginUrl(
    "postgres://postgres:placeholder@pg:5432/qm",
    OWNER_LOGIN,
    derivedLoginPassword(superuserPassword, OWNER_LOGIN),
  );

export function bootstrapDockerOwner(container: string, superuserPassword: string): void {
  const ownerPassword = derivedLoginPassword(superuserPassword, OWNER_LOGIN);
  const result = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "qm", "-v", "ON_ERROR_STOP=1", "-q"],
    { input: dockerOwnerBootstrapSql(ownerPassword), encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] },
  );
  if (result.status !== 0)
    throw new CliError(`could not prepare the ${OWNER_LOGIN} database login: ${result.stderr.trim() || "psql failed"}`);
}

export function externalDockerOwnerUrl(envFile: string | undefined): string | undefined {
  const file = envFile ? readEnvFile(envFile) : new Map<string, string>();
  const owner = process.env.DATABASE_OWNER_URL ?? file.get("DATABASE_OWNER_URL");
  if (owner) return owner;
  const stale = DATABASE_LOGIN_ENV_NAMES.filter((name) => name !== "DATABASE_OWNER_URL").find(
    (name) => process.env[name] ?? file.get(name),
  );
  if (stale)
    throw new CliError(
      `${stale} is now derived by qm; to use your own Postgres, set DATABASE_OWNER_URL to the login that owns the tables`,
    );
  return undefined;
}

export function pgContainerPassword(container: string): string | undefined {
  try {
    return capture("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", container])
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("POSTGRES_PASSWORD="))
      ?.slice("POSTGRES_PASSWORD=".length);
  } catch {
    return undefined;
  }
}
