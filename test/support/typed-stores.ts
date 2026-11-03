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
import { testAdvisoryLock, testDatabaseUrl } from "./test-database.ts";

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
