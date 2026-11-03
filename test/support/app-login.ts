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
  await owner.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
  const named = new URL(databaseUrl);
  named.username = role;
  await grantAppLogin(owner, named.toString());
  const url = new URL(databaseUrl);
  url.searchParams.set("options", [url.searchParams.get("options"), `-c role=${role}`].filter(Boolean).join(" "));
  return {
    url: url.toString(),
    async drop() {
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
      await owner.end();
    },
  };
}
