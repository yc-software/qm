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
import { createPostgresFeatureFlagStore } from "../../src/feature-flags.ts";
import {
  createPostgresIdempotencyStore,
  type IdempotencyStoreOptions,
} from "../../src/idempotency/idempotency-store.ts";
import { createPostgresExternalMemberStore } from "../../src/identity/external-members.ts";
import { createIdentityService, createPostgresDeactivationStore } from "../../src/identity/identity-service.ts";
import { createPostgresSkillStore } from "../../src/skills/postgres-skill-store.ts";
import { createPostgresSkillBundleStore } from "../../src/skills/skill-bundle-store.ts";
import { createPostgresSkillPackStore } from "../../src/skills/skill-pack-store.ts";
import type { SkillStoreOptions } from "../../src/skills/skill-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMigratedDatabaseUrl } from "./test-database.ts";

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


type IdentityOptions = Partial<Parameters<typeof createIdentityService>[1]>;

export function testIdentityService(opts: IdentityOptions = {}, url = testDatabaseUrl()) {
  return createIdentityService(createPostgresDeactivationStore(url), {
    externalMembers: createPostgresExternalMemberStore(url),
    ...opts,
  });
}

export function testIdempotencyStore(opts: IdempotencyStoreOptions = {}, url = testDatabaseUrl()) {
  return createPostgresIdempotencyStore(url, opts);
}

export function testFeatureFlagStore(url = testDatabaseUrl()) {
  return createPostgresFeatureFlagStore(url);
}

export function testSkillStore(opts: Partial<SkillStoreOptions> = {}, url = testDatabaseUrl()) {
  return createPostgresSkillStore(url, { advisoryLock: testAdvisoryLock(), ...opts });
}

export function testSkillPackStore(opts: { now?: () => number } = {}, url = testDatabaseUrl()) {
  return createPostgresSkillPackStore(url, opts);
}

export function testSkillBundleStore(url = testDatabaseUrl()) {
  return createPostgresSkillBundleStore(url);
}
