import { createPgPool, configurePgCaTrust, configurePgPooling } from "../persistence/pg-pool.ts";
import type { Head } from "./late.ts";
import { registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { type AdvisoryLock, createPostgresAdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPrincipalLinkService } from "../identity/principal-links.ts";
import { installPrincipalLinks } from "../directory/person.ts";
import { createIdentityService } from "../identity/identity-service.ts";
import { type LeaderLease, createPostgresLeaderLease } from "../persistence/leader-lease.ts";
import { createConfigStore } from "../resolution/config-store.ts";
import { type SkillStore, createSkillStore } from "../skills/skill-store.ts";
import { createSkillPackStore } from "../skills/skill-pack-store.ts";
import { createSkillBundleStore } from "../skills/skill-bundle-store.ts";
import { createFeatureFlagStore } from "../feature-flags.ts";
import { createPostgresTeamStore } from "../teams/teams.ts";
import { tenant } from "../tenant.ts";
import { type SessionStore, LLM_CAPTURE_RETENTION_MS } from "../sessions/session-store.ts";
import { createPostgresSessionStore } from "../sessions/postgres-session-store.ts";
import { createAdminGrantStore } from "../admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "../admin/postgres-admin-grant-store.ts";
import { parseAdminGrants, createAdminService } from "../admin/admin-service.ts";
import { createPostgresDirectoryStore } from "../directory/postgres-directory-store.ts";
import { createPostgresEnvironmentStore } from "../environments/environment-store.ts";
import { createProjectStore } from "../projects/project-store.ts";
import {
  createCanReadScope,
  createCanWriteScope,
  createCanManageScope,
  createManagesArtifactHome,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  type CanManageScope,
} from "../resolution/scope-membership.ts";
import { createPostgresDecisionStore } from "../decisions/store.ts";
import { createConnectorStatusCache } from "../credentials/connector-status.ts";
import { createSlackInstallationStore } from "../surfaces/slack-installation.ts";
import { mkdirSync } from "node:fs";
import { createJobWorker } from "../jobs/job-worker.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";

type StoresInputs = Pick<Head, "databaseUrl" | "config" | "connectorSecretKey" | "admittedWork">;

export function buildStores(deps: StoresInputs) {
  const { databaseUrl, config, connectorSecretKey, admittedWork } = deps;
  configurePgPooling({
    databaseUrl,
    ...(config.databasePoolUrl && !config.multitenant ? { poolUrl: config.databasePoolUrl } : {}),
    ...(config.databasePoolCaCert ? { caCert: config.databasePoolCaCert } : {}),
    ...(config.databasePoolMax !== undefined ? { queryMax: config.databasePoolMax } : {}),
    ...(config.databaseDirectPoolMax !== undefined ? { sessionMax: config.databaseDirectPoolMax } : {}),
    tenancy: config.multitenant,
    ...(config.tenantSecretsKey ? { tenantSecretsKey: config.tenantSecretsKey } : {}),
  });
  configurePgCaTrust({
    ...(config.databaseCaCert ? { cert: config.databaseCaCert } : {}),
    ...(config.databaseCaCertFile ? { certFile: config.databaseCaCertFile } : {}),
  });
  mkdirSync(config.dataDir, { recursive: true });

  const pgPool = createPgPool(databaseUrl, []);
  registerAbsurdSchema(databaseUrl);
  const advisoryLock: AdvisoryLock = createPostgresAdvisoryLock(pgPool);
  const principalLinks = createPrincipalLinkService(databaseUrl, advisoryLock);
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService(databaseUrl, {
    directorySyncProtected: () => tenantConfig(config).emailAuthPrincipals,
    principalLinks,
  });
  const leaderLease: LeaderLease = createPostgresLeaderLease(pgPool);
  const configStore = createConfigStore({ databaseUrl, connectorSecretKey });
  const skills: SkillStore = createSkillStore({
    databaseUrl,
    advisoryLock,
  });
  const skillPacks = createSkillPackStore({ databaseUrl });
  const skillBundles = createSkillBundleStore(databaseUrl);
  const featureFlags = createFeatureFlagStore(databaseUrl);
  const teams = createPostgresTeamStore(databaseUrl, featureFlags);
  const sessions: SessionStore = createPostgresSessionStore(databaseUrl);
  const adminGrantStore = createAdminGrantStore(createPostgresAdminGrantStore(databaseUrl), {
    seed: () => parseAdminGrants(tenantConfig(config).adminGrants, tenant().orgId) ?? [],
  });
  const admin = createAdminService(adminGrantStore, { trustedOidcAdminIssuer: config.trustedOidcAdminIssuer });
  const directory = createPostgresDirectoryStore(databaseUrl);
  const environments = createPostgresEnvironmentStore(databaseUrl);
  const projects = createProjectStore(databaseUrl, {
    isActiveMember: (principalId) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  });
  const canReadScope = createCanReadScope({ managedGroups: projects, directory, identity, teams });
  const canWriteScope = createCanWriteScope({ managedGroups: projects, directory, identity, teams });
  const canManageScope = createCanManageScope({ managedGroups: projects, directory, identity });
  const managesArtifactHome = createManagesArtifactHome(
    { managedGroups: projects, directory, identity, teams },
    canManageScope,
  );
  const currentScopeMembers = createCurrentScopeMembers({ managedGroups: projects, directory, identity });
  const isCurrentSharedScopeMember = createIsCurrentSharedScopeMember({ managedGroups: projects, directory, identity });
  const canUseSandboxScope: CanManageScope = async (actorId, scopeId) =>
    identity.isInternal(identity.classify(actorId)) &&
    ((await admin.adminStatusOf(identity.classify(actorId))).isAdmin || (await canWriteScope(actorId, scopeId)));
  const decisions = createPostgresDecisionStore(databaseUrl);
  const connectorStatusCache = createConnectorStatusCache(databaseUrl);
  const slackInstallation = createSlackInstallationStore(
    databaseUrl,
    () => tenantConfig(config).connectorSecretKey ?? connectorSecretKey,
  );
  const jobs = createJobWorker(databaseUrl);
  const every = (name: string, everyMs: number, fn: () => unknown, opts?: { immediate?: boolean }) =>
    jobs.every(name, everyMs, () => admittedWork.run(fn), opts);
  every("spend:refresh", 60_000, () => sessions.refreshSpendRollup(), { immediate: true });
  every("llm-capture:retention", 5 * 60_000, async () => {
    const purged = await sessions.purgeLlmCaptures(Date.now() - LLM_CAPTURE_RETENTION_MS, {
      deadline: Date.now() + 30_000,
    });
    if (purged) console.log(`[llm-capture] purged ${purged} prompt envelope(s) past retention`);
  });
  return {
    managesArtifactHome,
    skills,
    skillBundles,
    advisoryLock,
    identity,
    configStore,
    pgPool,
    canUseSandboxScope,
    decisions,
    featureFlags,
    sessions,
    canReadScope,
    canWriteScope,
    directory,
    projects,
    currentScopeMembers,
    admin,
    teams,
    connectorStatusCache,
    isCurrentSharedScopeMember,
    environments,
    leaderLease,
    skillPacks,
    slackInstallation,
    principalLinks,
    jobs,
    every,
    databaseUrl,
  };
}

export type StoresModule = ReturnType<typeof buildStores>;
