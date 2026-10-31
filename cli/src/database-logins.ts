import { createHmac } from "node:crypto";
import { CliError } from "./log.ts";

export const OWNER_LOGIN = "qm_owner";
export const APP_LOGIN = "qm_app";
export const READER_LOGIN = "qm_reader";

export interface DatabaseLoginEnv {
  DATABASE_OWNER_URL: string;
  DATABASE_URL: string;
  DATABASE_READER_URL: string;
}

export const DATABASE_LOGIN_ENV_NAMES = ["DATABASE_OWNER_URL", "DATABASE_URL", "DATABASE_READER_URL"] as const;

export function derivedLoginPassword(secret: string, login: string): string {
  return createHmac("sha256", secret).update(`qm-database-login:${login}`).digest("base64url");
}

function parsedDatabaseUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${what} is not a valid Postgres URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new CliError(`${what} must use the postgres:// or postgresql:// scheme`);
  if (!url.username || !url.password) throw new CliError(`${what} must carry a login name and password`);
  return url;
}

export function loginUrl(baseUrl: string, login: string, password: string): string {
  const url = parsedDatabaseUrl(baseUrl, "the database owner URL");
  url.username = login;
  url.password = password;
  return url.toString();
}

export function databaseLoginEnv(ownerUrl: string, passwords?: { app: string; reader: string }): DatabaseLoginEnv {
  const owner = parsedDatabaseUrl(ownerUrl, "DATABASE_OWNER_URL");
  const ownerLogin = decodeURIComponent(owner.username);
  if (ownerLogin === APP_LOGIN || ownerLogin === READER_LOGIN)
    throw new CliError(`DATABASE_OWNER_URL must name the login that owns the tables, not ${ownerLogin}`);
  const ownerPassword = decodeURIComponent(owner.password);
  return {
    DATABASE_OWNER_URL: ownerUrl,
    DATABASE_URL: loginUrl(ownerUrl, APP_LOGIN, passwords?.app ?? derivedLoginPassword(ownerPassword, APP_LOGIN)),
    DATABASE_READER_URL: loginUrl(
      ownerUrl,
      READER_LOGIN,
      passwords?.reader ?? derivedLoginPassword(ownerPassword, READER_LOGIN),
    ),
  };
}
