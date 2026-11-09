import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe } from "node:test";
import { createPostgresMapFactory } from "../../src/persistence/durable-map.ts";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { withoutTenant } from "../../src/tenants/context.ts";
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

export interface TwoTenantSuite extends Omit<TwoTenants, "close"> {
  readonly maps: ReturnType<typeof createPostgresMapFactory>;
  pairs(): Array<[string, string]>;
}

export function describeTwoTenants(name: string, fn: (db: TwoTenantSuite) => void): void {
  let db: TwoTenants | undefined;
  let maps: ReturnType<typeof createPostgresMapFactory> | undefined;
  const ready = (): TwoTenants => {
    if (!db) throw new Error("two-tenant database is not ready");
    return db;
  };
  const suite: TwoTenantSuite = {
    get owner() {
      return ready().owner;
    },
    get app() {
      return ready().app;
    },
    get appDatabaseUrl() {
      return ready().appDatabaseUrl;
    },
    get ownerDatabaseUrl() {
      return ready().ownerDatabaseUrl;
    },
    get tenants() {
      return ready().tenants;
    },
    get maps() {
      maps ??= createPostgresMapFactory(ready().appDatabaseUrl);
      return maps;
    },
    pairs: () => [
      [ready().tenants[0], "a"],
      [ready().tenants[1], "b"],
    ],
  };
  withoutTenant(() =>
    describe(name, () => {
      before(async () => {
        db = await twoTenants();
      });
      fn(suite);
      after(async () => {
        await maps?.pool.close();
        await db?.close();
      });
    }),
  );
}

export async function assertRowsByTenant(
  owner: PgPool,
  query: string,
  expected: unknown[][],
  params: unknown[] = [],
): Promise<void> {
  const byKey = (a: unknown[], b: unknown[]) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  const rows = (await owner.q(query, params)).map((row) => Object.values(row));
  assert.deepEqual(rows.toSorted(byKey), expected.toSorted(byKey));
}
