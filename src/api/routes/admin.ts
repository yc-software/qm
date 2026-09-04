import { type ApiCtx, type Route } from "./route.ts";
import {
  getAdminResources,
  getScopeConfig,
  listAdminScopes,
  putScopeConfig,
  retention,
  whoami,
} from "./admin/scope-config.ts";
import { egress, listAdminAudit, listAdminErrors, listAdminRuns, metrics } from "./admin/observability.ts";
import { getAdminSession, getAdminSessionLlm, listAdminSessions, listAdminShadowDeliveries } from "./admin/sessions.ts";
import { downloadAdminFile, listAdminFiles, readAdminFile, uploadAdminFile } from "./admin/files.ts";
import { archiveAdminSkill, getAdminSkill, listAdminArtifacts, putAdminCronDestination } from "./admin/artifacts.ts";
import { getAdminMemory, listMemoryScopes, putAdminMemory } from "./admin/memory.ts";
import { listSandboxRoutes, migrateSandboxScope } from "./admin/sandbox.ts";
import {
  createAdminGrant,
  getUserDetail,
  listKeychainStatus,
  listUsers,
  resetUserToBrandNew,
  revokeAdminGrant,
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
} from "./admin/slack-installation.ts";
import { deleteModelProvider, getModelProviders, putModelProvider } from "./admin/model-providers.ts";
import { deleteCustomProvider, getCustomProviders, putCustomProvider } from "./admin/custom-providers.ts";
import { deleteMcpServer, getMcpServers, putMcpServer } from "./admin/mcp-servers.ts";
import { listSecurityFlags, releaseSecurityTaint } from "./admin/security.ts";

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

const routes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/slack-installation", auth: "either", handle: getSlackInstallation },
  { method: "GET", path: "/v1/admin/slack-emoji", auth: "either", handle: getSlackEmojiList },
  { method: "PUT", path: "/v1/admin/slack-installation", auth: "either", handle: putSlackInstallation },
  { method: "DELETE", path: "/v1/admin/slack-installation", auth: "either", handle: deleteSlackInstallation },
  { method: "GET", path: "/v1/admin/model-providers", auth: "either", handle: getModelProviders },
  { method: "PUT", path: "/v1/admin/model-providers/:provider", auth: "either", handle: putModelProvider },
  { method: "GET", path: "/v1/admin/mcp-servers", auth: "either", handle: getMcpServers },
  { method: "PUT", path: "/v1/admin/mcp-servers/:id", auth: "either", handle: putMcpServer },
  { method: "DELETE", path: "/v1/admin/mcp-servers/:id", auth: "either", handle: deleteMcpServer },
  { method: "DELETE", path: "/v1/admin/model-providers/:provider", auth: "either", handle: deleteModelProvider },
  { method: "GET", path: "/v1/admin/custom-providers", auth: "either", handle: getCustomProviders },
  { method: "PUT", path: "/v1/admin/custom-providers/:provider", auth: "either", handle: putCustomProvider },
  { method: "DELETE", path: "/v1/admin/custom-providers/:provider", auth: "either", handle: deleteCustomProvider },
  { method: "PUT", path: "/v1/admin/scopes/:scope/:resource", auth: "either", handle: putScopeConfig },
  { method: "GET", path: "/v1/admin/whoami", auth: "either", handle: whoami },
  { method: "GET", path: "/v1/admin/scopes", auth: "either", handle: listAdminScopes },
  { method: "GET", path: "/v1/admin/scopes/:scope", auth: "either", handle: getScopeConfig },
  { method: "GET", path: "/v1/admin/resources", auth: "either", handle: getAdminResources },
  { method: "GET", path: "/v1/admin/retention", auth: "either", handle: retention },
  { method: "GET", path: "/v1/admin/metrics", auth: "either", handle: metrics },
  { method: "GET", path: "/v1/admin/egress", auth: "either", handle: egress },
  { method: "GET", path: "/v1/admin/sessions", auth: "either", handle: listAdminSessions },
  { method: "GET", path: "/v1/admin/sessions/:id/llm", auth: "either", handle: getAdminSessionLlm },
  { method: "GET", path: "/v1/admin/sessions/:id", auth: "either", handle: getAdminSession },
  { method: "GET", path: "/v1/admin/runs", auth: "either", handle: listAdminRuns },
  { method: "GET", path: "/v1/admin/deliveries/shadow", auth: "either", handle: listAdminShadowDeliveries },
  { method: "GET", path: "/v1/admin/slack-mirror/messages", auth: "either", handle: listSlackMirrorMessages },
  { method: "GET", path: "/v1/admin/slack-mirror", auth: "either", handle: listSlackMirrorContainers },
  { method: "GET", path: "/v1/admin/ambient-judgments", auth: "either", handle: listAmbientJudgments },
  { method: "GET", path: "/v1/admin/ack-emoji-picks", auth: "either", handle: listAckEmojiPicks },
  { method: "GET", path: "/v1/admin/files/read", auth: "either", handle: readAdminFile },
  { method: "GET", path: "/v1/admin/files/download", auth: "either", handle: downloadAdminFile },
  { method: "POST", path: "/v1/admin/files/upload", auth: "either", handle: uploadAdminFile },
  { method: "GET", path: "/v1/admin/files", auth: "either", handle: listAdminFiles },
  { method: "GET", path: "/v1/admin/errors", auth: "either", handle: listAdminErrors },
  { method: "GET", path: "/v1/admin/audit", auth: "either", handle: listAdminAudit },
  { method: "GET", path: "/v1/admin/security/flags", auth: "either", handle: listSecurityFlags },
  { method: "POST", path: "/v1/admin/security/release", auth: "either", handle: releaseSecurityTaint },
  {
    match: (m, p) =>
      m === "GET" && (p === "/v1/admin/crons" || p === "/v1/admin/deployments" || p === "/v1/admin/skills"),
    auth: "either",
    handle: listAdminArtifacts,
  },
  { method: "PUT", path: "/v1/admin/crons/:id/destination", auth: "either", handle: putAdminCronDestination },
  { method: "GET", path: "/v1/admin/skills/:id", auth: "either", handle: getAdminSkill },
  { method: "DELETE", path: "/v1/admin/skills/:id", auth: "either", handle: archiveAdminSkill },
  { method: "GET", path: "/v1/admin/memory/scopes", auth: "either", handle: listMemoryScopes },
  { method: "GET", path: "/v1/admin/memory", auth: "either", handle: getAdminMemory },
  { method: "PUT", path: "/v1/admin/memory", auth: "either", handle: putAdminMemory },
  { method: "GET", path: "/v1/admin/sandbox-routes", auth: "either", handle: listSandboxRoutes },
  { method: "POST", path: "/v1/admin/sandbox-routes/:scopeId/migrate", auth: "either", handle: migrateSandboxScope },
  { method: "GET", path: "/v1/admin/users", auth: "either", handle: listUsers },
  { method: "GET", path: "/v1/admin/directory", auth: "either", handle: searchDirectory },
  { method: "GET", path: "/v1/admin/keychain", auth: "either", handle: listKeychainStatus },
  { method: "GET", path: "/v1/admin/users/:principalId", auth: "either", handle: getUserDetail },
  { method: "PUT", path: "/v1/admin/users/:principalId/onboarding", auth: "either", handle: setUserOnboarding },
  { method: "POST", path: "/v1/admin/users/:principalId/reset", auth: "either", handle: resetUserToBrandNew },
  { method: "POST", path: "/v1/admin/grants", auth: "either", handle: createAdminGrant },
  { method: "DELETE", path: "/v1/admin/grants/:principalId", auth: "either", handle: revokeAdminGrant },
  { method: "POST", path: "/v1/admin/impersonate/stop", auth: "either", handle: stopImpersonation },
  { method: "POST", path: "/v1/admin/impersonate", auth: "either", handle: startImpersonation },
];

export const adminRoutes: ReadonlyArray<Route<ApiCtx>> = routes.map((r) => ({ ...r, handle: timed(r.handle) }));
