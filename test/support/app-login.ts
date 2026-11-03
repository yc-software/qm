import { randomBytes } from "node:crypto";
import pg from "pg";
import { grantAppLogin } from "../../src/tenants/logins.ts";

export interface AppLogin {
  url: string;
  drop(): Promise<void>;
}

export async function createAppLogin(databaseUrl: string): Promise<AppLogin> {
  const role = `qmt_app_${randomBytes(6).toString("hex")}`;
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS`);
  const named = new URL(databaseUrl);
  named.username = role;
  await grantAppLogin(owner, named.toString());
  named.password = role;
  return {
    url: named.toString(),
    async drop() {
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
      await owner.end();
    },
  };
}

export async function grantTestAppLogin(ownerUrl: string, appUrl: string): Promise<void> {
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await grantAppLogin(owner, appUrl);
  } finally {
    await owner.end();
  }
}
