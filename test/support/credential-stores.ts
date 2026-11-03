import { createPostgresKeychainRows } from "../../src/credentials/keychain-pg.ts";
import { createPostgresLinkTables } from "../../src/connectors/link-tables.ts";
import { createPostgresModelTables } from "../../src/model/model-tables.ts";
import { testDatabaseUrl } from "./test-database.ts";

export function testKeychainRows(url = testDatabaseUrl()) {
  return createPostgresKeychainRows(url);
}

export function testLinkTables(url = testDatabaseUrl()) {
  return createPostgresLinkTables(url);
}

export function testModelTables(url = testDatabaseUrl()) {
  return createPostgresModelTables(url);
}
