import { createPostgresKeychainRows } from "../../src/credentials/keychain-pg.ts";
import { createPostgresLinkTables } from "../../src/connectors/link-tables.ts";
import { createPostgresModelTables } from "../../src/model/model-tables.ts";
import { createPostgresCronRows } from "../../src/cron/cron-table.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { createPostgresMonitorRows } from "../../src/monitors/monitor-table.ts";
import { createPostgresWebhookRows } from "../../src/webhooks/webhook-table.ts";
import { createPostgresLoopRows } from "../../src/loops/loop-table.ts";
import { createPostgresItemRows } from "../../src/loops/item-table.ts";
import { createPostgresOutputRows } from "../../src/loops/output-table.ts";
import { createPostgresShipGrantRows } from "../../src/loops/ship-grant-table.ts";
import { createPostgresIngressDeliveryRows, createPostgresIngressSourceRows } from "../../src/loops/ingress-table.ts";
import { createPostgresSessionMailbox } from "../../src/sessions/session-mailbox.ts";
import { createPostgresMemoryTidyProfiles } from "../../src/memory/tidy-profiles.ts";
import { createPostgresSuggestedActivityProfiles } from "../../src/suggestions/activity-profiles.ts";
import { createPostgresSwarmRows } from "../../src/swarms/swarm-table.ts";
import { testDatabaseUrl, testMigratedDatabaseUrl } from "./test-database.ts";

export function testKeychainRows() {
  return createPostgresKeychainRows(testMigratedDatabaseUrl());
}

export function testLinkTables() {
  return createPostgresLinkTables(testMigratedDatabaseUrl());
}

export function testModelTables() {
  return createPostgresModelTables(testMigratedDatabaseUrl());
}

export const testCronRows = () => createPostgresCronRows(testDatabaseUrl());
export const testCronFires = () => createPostgresCronFireStore(testDatabaseUrl());
export const testMonitorRows = () => createPostgresMonitorRows(testDatabaseUrl());
export const testWebhookRows = () => createPostgresWebhookRows(testDatabaseUrl());
export const testLoopRows = () => createPostgresLoopRows(testDatabaseUrl());
export const testItemRows = () => createPostgresItemRows(testDatabaseUrl());
export const testOutputRows = () => createPostgresOutputRows(testDatabaseUrl());
export const testShipGrantRows = () => createPostgresShipGrantRows(testDatabaseUrl());
export const testIngressSourceRows = () => createPostgresIngressSourceRows(testDatabaseUrl());
export const testIngressDeliveryRows = () => createPostgresIngressDeliveryRows(testDatabaseUrl());
export const testSessionMailbox = () => createPostgresSessionMailbox(testDatabaseUrl());
export const testTidyProfiles = () => createPostgresMemoryTidyProfiles(testDatabaseUrl());
export const testActivityProfiles = () => createPostgresSuggestedActivityProfiles(testDatabaseUrl());
export const testSwarmRows = () => createPostgresSwarmRows(testDatabaseUrl());
