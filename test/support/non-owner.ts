import { randomUUID } from "node:crypto";
import pg from "pg";

export async function nonOwnerLogin(databaseUrl: string): Promise<string> {
  const role = `app_login_${randomUUID().slice(0, 8)}`;
  const owner = new pg.Client({ connectionString: databaseUrl });
  await owner.connect();
  try {
    await owner.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await owner.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await owner.query(`REVOKE ALL ON tenants, tenant_hosts FROM ${role}`);
  } finally {
    await owner.end();
  }
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}
