import pg from "pg";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function grantAppLogin(owner: Queryable, appDatabaseUrl: string): Promise<void> {
  const login = decodeURIComponent(new URL(appDatabaseUrl).username);
  const { rows } = await owner.query(
    `SELECT rolsuper OR rolbypassrls OR pg_has_role(oid, current_user, 'USAGE') AS owner
       FROM pg_roles WHERE rolname = $1`,
    [login],
  );
  if (!rows[0]) throw new Error(`DATABASE_URL names the login ${login}, which does not exist in this database`);
  if (rows[0].owner)
    throw new Error(`DATABASE_URL names ${login}, which owns the tables or bypasses row security; name the app login`);
  const role = pg.escapeIdentifier(login);
  const schemas = await owner.query(
    "SELECT nspname FROM pg_namespace WHERE nspname IN (current_schema(), 'pgboss') ORDER BY nspname",
  );
  for (const { nspname } of schemas.rows) {
    const schema = pg.escapeIdentifier(String(nspname));
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  }
  await owner.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await owner.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
  await owner.query(`REVOKE INSERT, UPDATE, DELETE ON tenants, qm_schema_migrations FROM ${role}`);
}
