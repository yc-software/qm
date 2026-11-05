import { randomUUID } from "node:crypto";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";
import { appUrl, ownerUrl } from "./test-tenant.ts";

export interface TwoTenants {
  owner: PgPool;
  app: PgPool;
  appDatabaseUrl: string;
  ownerDatabaseUrl: string;
  tenants: readonly [string, string];
  close(): Promise<void>;
}

export async function twoTenants(): Promise<TwoTenants> {
  const databaseUrl = testMigratedDatabaseUrl();
  const ownerDatabaseUrl = ownerUrl(databaseUrl).toString();
  const appDatabaseUrl = appUrl(databaseUrl);
  const owner = createPgPool(ownerDatabaseUrl);
  const app = createPgPool(appDatabaseUrl);
  const tenants = [randomUUID(), randomUUID()] as const;
  await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [...tenants]);
  return {
    owner,
    app,
    appDatabaseUrl,
    ownerDatabaseUrl,
    tenants,
    async close() {
      await app.close();
      await owner.close();
    },
  };
}
