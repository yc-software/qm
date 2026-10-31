import { pgConnectionOptions } from "./pg-pool.ts";

const RUNTIME_LOGIN_SQL = `SELECT current_user AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
  EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY (current_schemas(false))
      AND pg_has_role(current_user, c.relowner, 'USAGE')
  ) AS owner
  FROM pg_roles r WHERE r.rolname = current_user`;

export async function assertRuntimeLogin(databaseUrl: string): Promise<void> {
  const pg = (await import("pg")).default;
  const client = new pg.Client(pgConnectionOptions(databaseUrl));
  await client.connect();
  try {
    const { rows } = await client.query(RUNTIME_LOGIN_SQL);
    const role = rows[0] as { login: string; superuser: boolean; bypassrls: boolean; owner: boolean } | undefined;
    const problems = [
      role?.superuser ? "a superuser" : "",
      role?.bypassrls ? "allowed to bypass row-level security" : "",
      role?.owner ? "an owner of the tables" : "",
    ].filter(Boolean);
    if (problems.length)
      throw new Error(
        `DATABASE_URL logs in as ${role!.login}, which is ${problems.join(" and ")}; point DATABASE_URL at the qm_app login and DATABASE_OWNER_URL at the table owner`,
      );
  } finally {
    await client.end();
  }
}
