import { createPostgresKeychainRows } from "../../src/credentials/keychain-pg.ts";
import { createPostgresLinkTables } from "../../src/connectors/link-tables.ts";
import { createPostgresModelTables } from "../../src/model/model-tables.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";

export function testKeychainRows() {
  return createPostgresKeychainRows(testMigratedDatabaseUrl());
}

export function testLinkTables() {
  return createPostgresLinkTables(testMigratedDatabaseUrl());
}

export function testModelTables(url = testMigratedDatabaseUrl()) {
  return createPostgresModelTables(url);
}
