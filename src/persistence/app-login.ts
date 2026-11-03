import { scramVerifier } from "../../cli/src/scram-verifier.ts";
import { pgConnectionOptions } from "./pg-pool.ts";

const INVALID_PASSWORD = "28P01";
const MAX_NAME_BYTES = 63;

export type AppLoginChange = "created" | "password set" | "unchanged";

async function loginAccepted(url: string): Promise<boolean> {
  const pg = (await import("pg")).default;
  const client = new pg.Client(pgConnectionOptions(url));
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: unknown }).code === INVALID_PASSWORD) return false;
    throw error;
  }
  await client.end();
  return true;
}

export function appLoginName(ownerUrl: string, appUrl: string): string {
  const login = decodeURIComponent(new URL(appUrl).username);
  if (!login) throw new Error("DATABASE_URL must name the login core runs as");
  if (login === decodeURIComponent(new URL(ownerUrl).username))
    throw new Error(`DATABASE_URL logs in as ${login}, the table owner; give it a login of its own`);
  if (Buffer.byteLength(login) > MAX_NAME_BYTES)
    throw new Error(`DATABASE_URL's login ${login} is longer than the ${MAX_NAME_BYTES} bytes Postgres allows`);
  return login;
}

export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<AppLoginChange> {
  const login = appLoginName(ownerUrl, appUrl);
  if (await loginAccepted(appUrl)) return "unchanged";
  const pg = (await import("pg")).default;
  const owner = new pg.Client(pgConnectionOptions(ownerUrl));
  await owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('qm:app-login'))");
    if (await loginAccepted(appUrl)) {
      await owner.query("COMMIT");
      return "unchanged";
    }
    const exists = Boolean((await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login])).rowCount);
    const role = owner.escapeIdentifier(login);
    const password = `PASSWORD '${scramVerifier(decodeURIComponent(new URL(appUrl).password))}'`;
    await owner.query(
      exists
        ? `ALTER ROLE ${role} ${password}`
        : `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ${password}`,
    );
    await owner.query("COMMIT");
    return exists ? "password set" : "created";
  } finally {
    await owner.end();
  }
}
