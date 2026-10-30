import { scramVerifier } from "../../cli/src/scram-verifier.ts";

export const MANAGED_LOGINS = ["qm_app", "qm_reader"] as const;

function managedLogin(url: string | undefined): { user: string; password: string } | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  if (!(MANAGED_LOGINS as readonly string[]).includes(user) || !parsed.password) return undefined;
  return { user, password: decodeURIComponent(parsed.password) };
}

const insufficientPrivilege = (error: unknown): boolean => (error as { code?: unknown })?.code === "42501";

export async function setLoginPasswords(
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  urls: readonly (string | undefined)[],
): Promise<boolean> {
  let complete = true;
  for (const login of urls.map(managedLogin)) {
    if (!login) continue;
    const { rows } = await query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login.user]);
    if (rows.length === 0) {
      complete = false;
      continue;
    }
    try {
      await query(`ALTER ROLE ${login.user} PASSWORD '${scramVerifier(login.password)}'`);
    } catch (error) {
      if (!insufficientPrivilege(error)) throw error;
    }
  }
  return complete;
}
