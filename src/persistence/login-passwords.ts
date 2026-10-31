import type { Pool } from "pg";
import { scramVerifier } from "../../cli/src/scram-verifier.ts";

export const MANAGED_LOGINS = ["qm_app", "qm_reader"] as const;

type Query = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function managedLogin(url: string | undefined): { user: string; password: string } | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  if (!(MANAGED_LOGINS as readonly string[]).includes(user) || !parsed.password) return undefined;
  return { user, password: decodeURIComponent(parsed.password) };
}

export async function setLoginPasswords(query: Query, urls: readonly (string | undefined)[]): Promise<boolean> {
  let complete = true;
  for (const login of urls.map(managedLogin)) {
    if (!login) continue;
    const { rows } = await query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login.user]);
    if (rows.length === 0) {
      complete = false;
      continue;
    }
    await query("SAVEPOINT qm_login_password");
    try {
      await query(`ALTER ROLE ${login.user} PASSWORD '${scramVerifier(login.password)}'`);
      await query("RELEASE SAVEPOINT qm_login_password");
    } catch (error) {
      await query("ROLLBACK TO SAVEPOINT qm_login_password");
      if ((error as { code?: unknown })?.code !== "42501") throw error;
      console.warn(`[pg] ${login.user} is managed by the database provider; leaving its password as issued`);
    }
  }
  return complete;
}

export async function setPoolLoginPasswords(pool: Pool, urls: readonly (string | undefined)[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:managed-login-passwords'))");
    const complete = await setLoginPasswords((text, params) => client.query(text, params), urls);
    await client.query("COMMIT");
    return complete;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
