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
import { testAutoFlagger } from "./admin/auto-flagger-test.ts";
import { egress, listAdminAudit, listAdminErrors, listAdminRuns } from "./admin/observability.ts";
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
  getSlackEmojiList,
  getSlackInstallation,
  putSlackInstallation,
  startSlackInstallation,
  managedSlackRequest,
} from "./admin/slack-installation.ts";
import { deleteModelProvider, getModelProviders, putModelProvider } from "./admin/model-providers.ts";
import { deleteCustomProvider, getCustomProviders, putCustomProvider } from "./admin/custom-providers.ts";
import { deleteMcpServer, getMcpServers, putMcpServer } from "./admin/mcp-servers.ts";
import { listSecurityFlags } from "./admin/security.ts";
import { spend } from "./admin/spend.ts";
import { listUnattendedGrants } from "./admin/unattended-grants.ts";
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

const routes: Route<ApiCtx>[] = [
  { method: "POST", path: "/v1/slack/managed/installation", auth: "public", handle: managedSlackRequest },
  { method: "DELETE", path: "/v1/slack/managed/installation", auth: "public", handle: managedSlackRequest },
  { method: "POST", path: "/v1/slack/managed/events", auth: "public", handle: managedSlackRequest },
  ...withAdmin([
    { method: "POST", path: "/v1/admin/slack-installation/start", auth: "either", handle: startSlackInstallation },
    { method: "GET", path: "/v1/admin/slack-installation", auth: "either", handle: getSlackInstallation },
    { method: "GET", path: "/v1/admin/slack-emoji", auth: "either", handle: getSlackEmojiList },
    { method: "PUT", path: "/v1/admin/slack-installation", auth: "either", handle: putSlackInstallation },
    { method: "DELETE", path: "/v1/admin/slack-installation", auth: "either", handle: deleteSlackInstallation },
    { method: "GET", path: "/v1/admin/model-providers", auth: "either", handle: getModelProviders },
    { method: "PUT", path: "/v1/admin/model-providers/:provider", auth: "either", handle: putModelProvider },
    { method: "GET", path: "/v1/admin/mcp-servers", auth: "either", handle: getMcpServers },
    {
      method: "PUT",
      path: "/v1/admin/mcp-servers/:id",
      auth: "either",
      admin: { agent: { portalOnly: MCP_SERVERS } },
      handle: putMcpServer,
    },
    { method: "DELETE", path: "/v1/admin/mcp-servers/:id", auth: "either", handle: deleteMcpServer },
    { method: "DELETE", path: "/v1/admin/model-providers/:provider", auth: "either", handle: deleteModelProvider },
    { method: "POST", path: "/v1/admin/model-registry/lookup", auth: "either", handle: lookupRegistryModel },
    { method: "POST", path: "/v1/admin/model-registry/:model/enable", auth: "either", handle: enableBuiltinModel },
    { method: "GET", path: "/v1/admin/model-registry", auth: "either", handle: modelRegistry },
    { method: "PUT", path: "/v1/admin/model-registry/:model", auth: "either", handle: modelRegistry },
    { method: "DELETE", path: "/v1/admin/model-registry/:model", auth: "either", handle: modelRegistry },
    { method: "GET", path: "/v1/admin/custom-providers", auth: "either", handle: getCustomProviders },
    { method: "PUT", path: "/v1/admin/custom-providers/:provider", auth: "either", handle: putCustomProvider },
    { method: "DELETE", path: "/v1/admin/custom-providers/:provider", auth: "either", handle: deleteCustomProvider },
    {
      method: "POST",
      path: "/v1/admin/scopes/:scope/auto-flagger/test",
      auth: "either",
      handle: testAutoFlagger,
    },
    { method: "PUT", path: "/v1/admin/scopes/:scope/:resource", auth: "either", handle: putScopeConfig },
    { method: "GET", path: "/v1/admin/whoami", auth: "either", admin: { agent: "anyone" }, handle: whoami },
    {
      method: "GET",
      path: "/v1/admin/scopes",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.sessions.read", summary: "list the scope directory" },
      },
      handle: listAdminScopes,
    },
    {
      method: "GET",
      path: "/v1/admin/scopes/:scope",
      auth: "either",
      admin: { privateRead: "unless-org-scope" },
      handle: getScopeConfig,
    },
    {
      method: "GET",
      path: "/v1/admin/scopes/:scope/credential-usage",
      auth: "either",
      admin: { privateRead: "unless-org-scope" },
      handle: getCredentialUsageSummary,
    },
    { method: "GET", path: "/v1/admin/resources", auth: "either", handle: getAdminResources },
    {
      method: "GET",
      path: "/v1/admin/unattended-grants",
      auth: "either",
      handle: (ctx) => listUnattendedGrants(ctx, routes),
    },
    { method: "GET", path: "/v1/admin/retention", auth: "either", handle: retention },
    {
      method: "GET",
      path: "/v1/admin/spend",
      auth: "either",
      admin: { unattended: { grant: "admin.spend.read", summary: "read the org spend report" } },
      handle: spend,
    },
    {
      method: "GET",
      path: "/v1/admin/egress",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.egress.read", summary: "read scope-labelled egress decisions" },
      },
      handle: egress,
    },
    {
      method: "GET",
      path: "/v1/admin/sessions",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.sessions.read", summary: "list conversation metadata" },
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
        unattended: { grant: "admin.sessions.read", summary: "read a conversation transcript" },
      },
      handle: getAdminSession,
    },
    {
      method: "GET",
      path: "/v1/admin/runs",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.sessions.read", summary: "read queued, in-flight, and recent runs" },
      },
      handle: listAdminRuns,
    },
    {
      method: "GET",
      path: "/v1/admin/deliveries/shadow",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listAdminShadowDeliveries,
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
        unattended: { grant: "admin.files.read", summary: "read a stored file by ?id=" },
      },
      handle: readAdminFile,
    },
    {
      method: "GET",
      path: "/v1/admin/files/download",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.files.read", summary: "download a stored file by ?id=" },
      },
      handle: downloadAdminFile,
    },
    { method: "POST", path: "/v1/admin/files/upload", auth: "either", handle: uploadAdminFile },
    {
      method: "GET",
      path: "/v1/admin/files",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.files.read", summary: "list a scope's document store" },
      },
      handle: listAdminFiles,
    },
    {
      method: "GET",
      path: "/v1/admin/errors",
      auth: "either",
      admin: { privateRead: "always", unattended: { grant: "admin.sessions.read", summary: "read error telemetry" } },
      handle: listAdminErrors,
    },
    {
      method: "GET",
      path: "/v1/admin/audit",
      auth: "either",
      admin: {
        privateRead: "always",
        unattended: { grant: "admin.audit.read", summary: "read security audit events" },
      },
      handle: listAdminAudit,
    },
    {
      method: "GET",
      path: "/v1/admin/security/flags",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listSecurityFlags,
    },
    {
      method: "GET",
      path: "/v1/admin/crons",
      auth: "either",
      admin: { privateRead: "always", unattended: { grant: "admin.crons.read", summary: "list a scope's crons" } },
      handle: listAdminArtifacts,
    },
    {
      method: "GET",
      path: "/v1/admin/deployments",
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
      admin: { privateRead: "unless-org-scope" },
      handle: adminMemory,
    },
    { method: "POST", path: "/v1/admin/memory", auth: "either", handle: adminMemory },
    { method: "PATCH", path: "/v1/admin/memory", auth: "either", handle: adminMemory },
    { method: "DELETE", path: "/v1/admin/memory", auth: "either", handle: adminMemory },
    { method: "GET", path: "/v1/admin/sandboxes/:scopeId", auth: "either", handle: manageSandboxResources },
    { method: "POST", path: "/v1/admin/sandboxes/:scopeId", auth: "either", handle: manageSandboxResources },
    { method: "GET", path: "/v1/admin/users", auth: "either", handle: listUsers },
    { method: "GET", path: "/v1/admin/directory", auth: "either", handle: searchDirectory },
    {
      method: "GET",
      path: "/v1/admin/keychain",
      auth: "either",
      admin: { privateRead: "always" },
      handle: listKeychainStatus,
    },
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
      admin: { agent: { portalOnly: GRANTS } },
      handle: createAdminGrant,
    },
    {
      method: "DELETE",
      path: "/v1/admin/grants/:principalId",
      auth: "either",
      admin: { agent: { portalOnly: GRANTS } },
      handle: revokeAdminGrant,
    },
    { method: "POST", path: "/v1/admin/users/invite", auth: "either", handle: inviteTeammate },
    { method: "POST", path: "/v1/admin/external-users", auth: "either", handle: inviteExternalUser },
    { method: "DELETE", path: "/v1/admin/external-users/:email", auth: "either", handle: revokeExternalUser },
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
