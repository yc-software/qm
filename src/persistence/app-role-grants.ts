type Query = (text: string, params?: unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export async function grantAppRole(query: Query, role: string, schema: string): Promise<void> {
  for (const name of [role, schema])
    if (!IDENTIFIER.test(name)) throw new Error(`invalid database identifier: ${name}`);
  await query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
  await query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  await query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
  await query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${role}`,
  );
  await query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
  await query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`);
  const tenants = await query("SELECT to_regclass(format('%I.tenants', $1::text)) IS NOT NULL AS present", [schema]);
  if (tenants[0]?.present !== true) return;
  await query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${schema}.tenants FROM ${role}`);
  await query(`GRANT REFERENCES ON ${schema}.tenants TO ${role}`);
}
