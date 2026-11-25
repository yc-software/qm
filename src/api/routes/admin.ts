import { modelRegistry, lookupRegistryModel, enableBuiltinModel } from "./admin/model-registry.ts";
import { withAdmin, type ApiCtx, type Route } from "./route.ts";
import {
  getAdminResources,
  getScopeConfig,
  getCredentialUsageSummary,
  listAdminScopes,
  putScopeConfig,
  retention,
  whoami,
} from "./admin/scope-config.ts";
import { egress, listAdminAudit, listAdminErrors } from "./admin/observability.ts";
import { getAdminSession, getAdminSessionLlm, listAdminSessions, listAdminShadowDeliveries } from "./admin/sessions.ts";
import { downloadAdminFile, listAdminFiles, readAdminFile, uploadAdminFile } from "./admin/files.ts";
import {
  archiveAdminSkill,
  getAdminSkill,
  listAdminArtifacts,
  putAdminCronDestination,
  putAdminCronRuntime,
} from "./admin/artifacts.ts";
import { adminMemory, listMemoryScopes } from "./admin/memory.ts";
import { manageSandboxResources } from "./admin/sandbox.ts";
import {
  createAdminGrant,
  getUserDetail,
  inviteExternalUser,
  inviteTeammate,
  listKeychainStatus,
  createAdminKeychainGrant,
  listUsers,
  resetUserToBrandNew,
  revokeAdminGrant,
  revokeExternalUser,
  searchDirectory,
  setUserOnboarding,
  startImpersonation,
  stopImpersonation,
} from "./admin/users.ts";
import {
  listAckEmojiPicks,
  listAmbientJudgments,
  listSlackMirrorContainers,
  listSlackMirrorMessages,
} from "./admin/slack-mirror.ts";
import {
  deleteSlackInstallation,
  getSlackConfigToken,
  putSlackConfigToken,
  deleteSlackConfigToken,
  getSlackEmojiList,
  getSlackInstallation,
  putSlackInstallation,
  createSlackInstallation,
  slackOAuthCallback,
  startSlackInstallation,
  managedSlackEvent,
  managedSlackRequest,
} from "./admin/slack-installation.ts";
import { deleteModelProvider, getModelProviders, putModelProvider } from "./admin/model-providers.ts";
import { deleteCustomProvider, getCustomProviders, putCustomProvider } from "./admin/custom-providers.ts";
import { deleteMcpServer, getMcpServers, putMcpServer } from "./admin/mcp-servers.ts";
import {
  deleteMemoryBinding,
  deleteMemoryBrain,
  getMemoryBinding,
  getMemoryBrain,
  getMemoryRegistry,
  putMemberBrains,
  putMemoryBinding,
  putMemoryBrain,
} from "./admin/memory-registry.ts";
import { listSecurityFlags } from "./admin/security.ts";
import { spend } from "./admin/spend.ts";
import { offboardUser, reactivateUser } from "./admin/offboard.ts";
import { createPrincipalLink, deletePrincipalLink, listPrincipalLinks } from "./admin/principal-links.ts";

const timed =
  (handle: (ctx: ApiCtx) => void | Promise<void>) =>
  async (ctx: ApiCtx): Promise<void> => {
    const started = Date.now();
    let threw = false;
    try {
      await handle(ctx);
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      console.log(
        `[admin] ${ctx.method} ${ctx.pathname} ${threw ? 500 : ctx.res.statusCode} ${Date.now() - started}ms`,
      );
    }
  };

const GRANTS = "admin grant changes (promote/revoke) are portal-only — the agent cannot manage who governs the org";
const IMPERSONATE = "impersonating a user is portal-only — the agent cannot act as another person";
const MCP_SERVERS =
  "registering or changing an MCP server is portal-only — the agent cannot change which tools it can call or which calls need approval";
const LINKS = "identity links are portal-only — the agent cannot decide which sign-ins belong to one person";
const MEMORY_REGISTRY_DELETE =
  "deleting a memory brain or binding never goes through the agent — an org admin deletes it through the admin API outside chat";

const routes: Route<ApiCtx>[] = [
  {
    method: "POST",
    path: "/v1/slack/managed/installation",
    auth: "public",
    tenant: "none",
    handle: managedSlackRequest,
  },
  {
    method: "DELETE",
    path: "/v1/slack/managed/installation",
    auth: "public",
    tenant: "none",
    handle: managedSlackRequest,
  },
  { method: "POST", path: "/v1/slack/managed/events", auth: "public", tenant: "none", handle: managedSlackEvent },
  { method: "GET", path: "/v1/slack/oauth/callback", auth: "public", handle: slackOAuthCallback },
  ...withAdmin([
    {
      method: "POST",
      path: "/v1/admin/slack-installation/start",
      auth: "either",
      admin: { owner: true },
      handle: startSlackInstallation,
    },
    {
      method: "POST",
      path: "/v1/admin/slack-installation/create",
      auth: "either",
      admin: { owner: true },
      handle: createSlackInstallation,
    },
    {
      method: "GET",
      path: "/v1/admin/slack-installation",
      auth: "either",
      admin: { owner: true },
      handle: getSlackInstallation,
    },
    { method: "GET", path: "/v1/admin/slack-emoji", auth: "either", admin: { owner: true }, handle: getSlackEmojiList },
    {
      method: "PUT",
      path: "/v1/admin/slack-installation",
      auth: "either",
      admin: { owner: true },
      handle: putSlackInstallation,
    },
    {
      method: "DELETE",
      path: "/v1/admin/slack-installation",
      auth: "either",
      admin: { owner: true },
      handle: deleteSlackInstallation,
    },
    {
      method: "GET",
      path: "/v1/admin/slack-config-token",
      auth: "either",
      admin: { owner: true },
      handle: getSlackConfigToken,
    },
    {
      method: "PUT",
      path: "/v1/admin/slack-config-token",
      auth: "either",
      admin: { owner: true },
      handle: putSlackConfigToken,
    },
    {
      method: "DELETE",
      path: "/v1/admin/slack-config-token",
      auth: "either",
      admin: { owner: true },
      handle: deleteSlackConfigToken,
    },
    {
      method: "GET",
      path: "/v1/admin/model-providers",
      auth: "either",
      admin: { owner: true },
      handle: getModelProviders,
    },
    {
      method: "PUT",
      path: "/v1/admin/model-providers/:provider",
      auth: "either",
      admin: { owner: true },
      handle: putModelProvider,
    },
    { method: "GET", path: "/v1/admin/mcp-servers", auth: "either", admin: { owner: true }, handle: getMcpServers },
    {
      method: "PUT",
      path: "/v1/admin/mcp-servers/:id",
      auth: "either",
      admin: { agent: { portalOnly: MCP_SERVERS }, owner: true },
      handle: putMcpServer,
    },
    {
      method: "DELETE",
      path: "/v1/admin/mcp-servers/:id",
      auth: "either",
      admin: { owner: true },
      handle: deleteMcpServer,
    },
    {
      method: "DELETE",
      path: "/v1/admin/model-providers/:provider",
      auth: "either",
      admin: { owner: true },
      handle: deleteModelProvider,
    },
    {
      method: "POST",
      path: "/v1/admin/model-registry/lookup",
      auth: "either",
      admin: { owner: true },
      handle: lookupRegistryModel,
    },
    {
      method: "POST",
      path: "/v1/admin/model-registry/:model/enable",
      auth: "either",
      admin: { owner: true },
      handle: enableBuiltinModel,
    },
    { method: "GET", path: "/v1/admin/model-registry", auth: "either", admin: { owner: true }, handle: modelRegistry },
    {
      method: "PUT",
      path: "/v1/admin/model-registry/:model",
      auth: "either",
      admin: { owner: true },
      handle: modelRegistry,
    },
    {
      method: "DELETE",
      path: "/v1/admin/model-registry/:model",
      auth: "either",
      admin: { owner: true },
      handle: modelRegistry,
    },
    {
      method: "GET",
      path: "/v1/admin/custom-providers",
      auth: "either",
      admin: { owner: true },
      handle: getCustomProviders,
    },
    {
      method: "PUT",
      path: "/v1/admin/custom-providers/:provider",
      auth: "either",
      admin: { owner: true },
      handle: putCustomProvider,
    },
    {
      method: "DELETE",
      path: "/v1/admin/custom-providers/:provider",
      auth: "either",
      admin: { owner: true },
      handle: deleteCustomProvider,
    },
    {
      method: "PUT",
      path: "/v1/admin/scopes/:scope/:resource",
      auth: "either",
      admin: { owner: true },
      handle: putScopeConfig,
    },
    { method: "GET", path: "/v1/admin/whoami", auth: "either", admin: { agent: "anyone" }, handle: whoami },
    {
      method: "GET",
      path: "/v1/admin/scopes",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: listAdminScopes,
    },
    {
      method: "GET",
      path: "/v1/admin/scopes/:scope",
      auth: "either",
      admin: { privateRead: "unless-org-scope", owner: true },
      handle: getScopeConfig,
    },
    {
      method: "GET",
      path: "/v1/admin/scopes/:scope/credential-usage",
      auth: "either",
      admin: { privateRead: "unless-org-scope", owner: true },
      handle: getCredentialUsageSummary,
    },
    { method: "GET", path: "/v1/admin/resources", auth: "either", admin: { owner: true }, handle: getAdminResources },
    { method: "GET", path: "/v1/admin/retention", auth: "either", admin: { owner: true }, handle: retention },
    {
      method: "GET",
      path: "/v1/admin/spend",
      auth: "either",
      admin: { owner: true },
      handle: spend,
    },
    {
      method: "GET",
      path: "/v1/admin/egress",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: egress,
    },
    {
      method: "GET",
      path: "/v1/admin/sessions",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: listAdminSessions,
    },
    {
      method: "GET",
      path: "/v1/admin/sessions/:id/llm",
      auth: "either",
      admin: { privateRead: "always" },
      handle: getAdminSessionLlm,
    },
    {
      method: "GET",
      path: "/v1/admin/sessions/:id",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: getAdminSession,
    },
    {
      method: "GET",
      path: "/v1/admin/slack-mirror/messages",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listSlackMirrorMessages,
    },
    {
      method: "GET",
      path: "/v1/admin/slack-mirror",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listSlackMirrorContainers,
    },
    {
      method: "GET",
      path: "/v1/admin/ambient-judgments",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAmbientJudgments,
    },
    {
      method: "GET",
      path: "/v1/admin/ack-emoji-picks",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAckEmojiPicks,
    },
    {
      method: "GET",
      path: "/v1/admin/files/read",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: readAdminFile,
    },
    {
      method: "GET",
      path: "/v1/admin/files/download",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: downloadAdminFile,
    },
    {
      method: "GET",
      path: "/v1/admin/files",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: listAdminFiles,
    },
    { method: "POST", path: "/v1/admin/files/upload", auth: "either", streamBody: true, handle: uploadAdminFile },
    {
      method: "GET",
      path: "/v1/admin/errors",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminErrors,
    },
    {
      method: "GET",
      path: "/v1/admin/audit",
      auth: "either",
      admin: {
        privateRead: "always",
      },
      handle: listAdminAudit,
    },
    {
      method: "GET",
      path: "/v1/admin/crons",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminArtifacts,
    },
    {
      method: "GET",
      path: "/v1/admin/apps",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminArtifacts,
    },
    {
      method: "GET",
      path: "/v1/admin/skills",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminArtifacts,
    },
    { method: "PUT", path: "/v1/admin/crons/:id/runtime", auth: "either", handle: putAdminCronRuntime },
    { method: "PUT", path: "/v1/admin/crons/:id/destination", auth: "either", handle: putAdminCronDestination },
    {
      method: "GET",
      path: "/v1/admin/skills/:id",
      auth: "either",
      admin: { privateRead: "always" },
      handle: getAdminSkill,
    },
    { method: "DELETE", path: "/v1/admin/skills/:id", auth: "either", handle: archiveAdminSkill },
    { method: "GET", path: "/v1/admin/memory/scopes", auth: "either", handle: listMemoryScopes },
    {
      method: "GET",
      path: "/v1/admin/memory",
      auth: "either",
      admin: { privateRead: "unless-org-scope", owner: true },
      handle: adminMemory,
    },
    {
      method: "GET",
      path: "/v1/admin/memory-registry",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: getMemoryRegistry,
    },
    {
      method: "GET",
      path: "/v1/admin/memory-registry/brains/:id",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: getMemoryBrain,
    },
    {
      method: "PUT",
      path: "/v1/admin/memory-registry/brains/:id",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: putMemoryBrain,
    },
    {
      method: "DELETE",
      path: "/v1/admin/memory-registry/brains/:id",
      auth: "either",
      admin: { agent: { portalOnly: MEMORY_REGISTRY_DELETE }, owner: true },
      handle: deleteMemoryBrain,
    },
    {
      method: "GET",
      path: "/v1/admin/memory-registry/bindings/:id",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: getMemoryBinding,
    },
    {
      method: "PUT",
      path: "/v1/admin/memory-registry/bindings/:id",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: putMemoryBinding,
    },
    {
      method: "DELETE",
      path: "/v1/admin/memory-registry/bindings/:id",
      auth: "either",
      admin: { agent: { portalOnly: MEMORY_REGISTRY_DELETE }, owner: true },
      handle: deleteMemoryBinding,
    },
    {
      method: "PUT",
      path: "/v1/admin/memory-registry/member-brains",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: putMemberBrains,
    },
    { method: "POST", path: "/v1/admin/memory", auth: "either", admin: { owner: true }, handle: adminMemory },
    { method: "PATCH", path: "/v1/admin/memory", auth: "either", admin: { owner: true }, handle: adminMemory },
    { method: "DELETE", path: "/v1/admin/memory", auth: "either", admin: { owner: true }, handle: adminMemory },
    { method: "GET", path: "/v1/admin/users", auth: "either", admin: { owner: true }, handle: listUsers },
    { method: "GET", path: "/v1/admin/directory", auth: "either", admin: { owner: true }, handle: searchDirectory },
    {
      method: "GET",
      path: "/v1/admin/keychain",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listKeychainStatus,
    },
    { method: "POST", path: "/v1/admin/keychain/grants", auth: "either", handle: createAdminKeychainGrant },
    {
      method: "GET",
      path: "/v1/admin/users/:principalId",
      auth: "either",
      admin: { privateRead: "always" },
      handle: getUserDetail,
    },
    { method: "PUT", path: "/v1/admin/users/:principalId/onboarding", auth: "either", handle: setUserOnboarding },
    { method: "POST", path: "/v1/admin/users/:principalId/reset", auth: "either", handle: resetUserToBrandNew },
    {
      method: "POST",
      path: "/v1/admin/users/:principalId/offboard",
      auth: "either",
      admin: { privateRead: "always", owner: true },
      handle: offboardUser,
    },
    {
      method: "POST",
      path: "/v1/admin/users/:principalId/reactivate",
      auth: "either",
      admin: { owner: true },
      handle: reactivateUser,
    },
    {
      method: "GET",
      path: "/v1/admin/principal-links",
      auth: "either",
      admin: { agent: { portalOnly: LINKS } },
      handle: listPrincipalLinks,
    },
    {
      method: "POST",
      path: "/v1/admin/principal-links",
      auth: "either",
      admin: { agent: { portalOnly: LINKS } },
      handle: createPrincipalLink,
    },
    {
      method: "DELETE",
      path: "/v1/admin/principal-links/:principalId",
      auth: "either",
      admin: { agent: { portalOnly: LINKS } },
      handle: deletePrincipalLink,
    },
    {
      method: "POST",
      path: "/v1/admin/grants",
      auth: "either",
      admin: { agent: { portalOnly: GRANTS }, owner: true },
      handle: createAdminGrant,
    },
    {
      method: "DELETE",
      path: "/v1/admin/grants/:principalId",
      auth: "either",
      admin: { agent: { portalOnly: GRANTS }, owner: true },
      handle: revokeAdminGrant,
    },
    { method: "POST", path: "/v1/admin/users/invite", auth: "either", admin: { owner: true }, handle: inviteTeammate },
    {
      method: "POST",
      path: "/v1/admin/external-users",
      auth: "either",
      admin: { owner: true },
      handle: inviteExternalUser,
    },
    {
      method: "DELETE",
      path: "/v1/admin/external-users/:email",
      auth: "either",
      admin: { owner: true },
      handle: revokeExternalUser,
    },
  ]).map((route) => ({ ...route, browser: "self" as const })),
  ...withAdmin([
    {
      method: "GET",
      path: "/v1/admin/deliveries/shadow",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminShadowDeliveries,
    },
    {
      method: "GET",
      path: "/v1/admin/security/flags",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listSecurityFlags,
    },
    { method: "GET", path: "/v1/admin/sandboxes/:scopeId", auth: "either", handle: manageSandboxResources },
    { method: "POST", path: "/v1/admin/sandboxes/:scopeId", auth: "either", handle: manageSandboxResources },
    {
      method: "POST",
      path: "/v1/admin/impersonate/stop",
      auth: "either",
      admin: { agent: { portalOnly: IMPERSONATE } },
      handle: stopImpersonation,
    },
    {
      method: "POST",
      path: "/v1/admin/impersonate",
      auth: "either",
      admin: { agent: { portalOnly: IMPERSONATE } },
      handle: startImpersonation,
    },
  ]),
];

export const adminRoutes: ReadonlyArray<Route<ApiCtx>> = routes.map((r) => ({ ...r, handle: timed(r.handle) }));
