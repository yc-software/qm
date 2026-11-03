import { APP_LOGIN, READER_LOGIN, derivedLoginPassword } from "../../cli/src/database-logins.ts";
import { scramVerifier } from "../../cli/src/scram-verifier.ts";
import { pgConnectionOptions } from "./pg-pool.ts";

const INVALID_PASSWORD = "28P01";

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

export async function setLoginPasswords(ownerUrl: string, appUrl: string): Promise<string[]> {
  const app = new URL(appUrl);
  if (decodeURIComponent(app.username) !== APP_LOGIN)
    throw new Error(`DATABASE_URL must log in as ${APP_LOGIN}, not ${decodeURIComponent(app.username)}`);
  if (await loginAccepted(appUrl)) return [];
  const ownerPassword = decodeURIComponent(new URL(ownerUrl).password);
  const passwords = [
    [APP_LOGIN, decodeURIComponent(app.password)],
    [READER_LOGIN, derivedLoginPassword(ownerPassword, READER_LOGIN)],
  ] as const;
  const pg = (await import("pg")).default;
  const owner = new pg.Client(pgConnectionOptions(ownerUrl));
  await owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('qm:login-passwords'))");
    if (await loginAccepted(appUrl)) {
      await owner.query("COMMIT");
      return [];
    }
    for (const [login, password] of passwords)
      await owner.query(`ALTER ROLE ${login} PASSWORD '${scramVerifier(password)}'`);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  } finally {
    await owner.end();
  }
  return passwords.map(([login]) => login);
}
