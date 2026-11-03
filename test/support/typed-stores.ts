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
import { testDatabaseUrl } from "./test-database.ts";
import { tenantBoundUrl } from "./test-tenants.ts";
import { afterEach } from "node:test";

let shared: string | undefined;
afterEach(() => {
  shared = undefined;
});

export const testSharedDatabaseUrl = (): string => (shared ??= testDatabaseUrl());

export const testCronRows = (url = testSharedDatabaseUrl()) => createPostgresCronRows(tenantBoundUrl(url));
export const testCronFires = (url = testSharedDatabaseUrl()) => createPostgresCronFireStore(tenantBoundUrl(url));
export const testMonitorRows = (url = testSharedDatabaseUrl()) => createPostgresMonitorRows(tenantBoundUrl(url));
export const testWebhookRows = (url = testSharedDatabaseUrl()) => createPostgresWebhookRows(tenantBoundUrl(url));
export const testLoopRows = (url = testSharedDatabaseUrl()) => createPostgresLoopRows(tenantBoundUrl(url));
export const testItemRows = (url = testSharedDatabaseUrl()) => createPostgresItemRows(tenantBoundUrl(url));
export const testOutputRows = (url = testSharedDatabaseUrl()) => createPostgresOutputRows(tenantBoundUrl(url));
export const testShipGrantRows = (url = testSharedDatabaseUrl()) => createPostgresShipGrantRows(tenantBoundUrl(url));
export const testIngressSourceRows = (url = testSharedDatabaseUrl()) =>
  createPostgresIngressSourceRows(tenantBoundUrl(url));
export const testIngressDeliveryRows = (url = testSharedDatabaseUrl()) =>
  createPostgresIngressDeliveryRows(tenantBoundUrl(url));
export const testSessionMailbox = (url = testSharedDatabaseUrl()) => createPostgresSessionMailbox(tenantBoundUrl(url));
export const testTidyProfiles = (url = testSharedDatabaseUrl()) =>
  createPostgresMemoryTidyProfiles(tenantBoundUrl(url));
export const testActivityProfiles = (url = testSharedDatabaseUrl()) =>
  createPostgresSuggestedActivityProfiles(tenantBoundUrl(url));
export const testSwarmRows = (url = testSharedDatabaseUrl()) => createPostgresSwarmRows(tenantBoundUrl(url));
