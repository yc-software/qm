import { type AdminAccess, type ApiCtx, Reply, type Route, type RouteResult, withAdmin } from "./route.ts";
import { HttpError } from "../http.ts";
import {
  getAdminResources,
  getScopeConfig,
  getCredentialUsageSummary,
  listAdminScopes,
  putScopeConfig,
  retention,
  whoami,
} from "./admin/scope-config.ts";
import { egress, listAdminAudit, listAdminErrors, listAdminRuns } from "./admin/observability.ts";
import { getAdminSession, getAdminSessionLlm, listAdminSessions } from "./admin/sessions.ts";
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
  startImpersonation,
  stopImpersonation,
} from "./admin/users.ts";
import {
  listAckEmojiPicks,
  listAmbientJudgments,
  listAmbientContainers,
  listAmbientMessages,
} from "./admin/ambient.ts";
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
  (handle: Route<ApiCtx>["handle"]) =>
  async (ctx: ApiCtx): Promise<RouteResult> => {
    const started = Date.now();
    let status: number | undefined;
    try {
      const out = await handle(ctx);
      if (out instanceof Reply) status = out.status;
      return out;
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      throw err;
    } finally {
      console.log(`[admin] ${ctx.method} ${ctx.pathname} ${status ?? ctx.res.statusCode} ${Date.now() - started}ms`);
    }
  };

const GRANTS = "admin grant changes (promote/revoke) are portal-only — the agent cannot manage who governs the org";
const IMPERSONATE = "impersonating a user is portal-only — the agent cannot act as another person";
const MCP_SERVERS =
  "registering or changing an MCP server is portal-only — the agent cannot change which tools it can call or which calls need approval";
const LINKS = "identity links are portal-only — the agent cannot decide which sign-ins belong to one person";

type Grant = NonNullable<AdminAccess["unattended"]>["grant"];
const PRIVATE: AdminAccess = { privateRead: "always" };
const UNLESS_ORG: AdminAccess = { privateRead: "unless-org-scope" };
const unattended = (grant: Grant, summary: string): AdminAccess => ({
  privateRead: "always",
  unattended: { grant, summary },
});
const portalOnly = (reason: string): AdminAccess => ({ agent: { portalOnly: reason } });

const route = (method: string, path: string, handle: Route<ApiCtx>["handle"], admin?: AdminAccess): Route<ApiCtx> => ({
  method,
  path: `/v1/admin${path}`,
  auth: "either",
  handle,
  ...(admin ? { admin } : {}),
});

const routes: Route<ApiCtx>[] = [
  { method: "POST", path: "/v1/slack/managed/installation", auth: "public", handle: managedSlackRequest },
  { method: "DELETE", path: "/v1/slack/managed/installation", auth: "public", handle: managedSlackRequest },
  { method: "POST", path: "/v1/slack/managed/events", auth: "public", handle: managedSlackRequest },
  ...withAdmin([
    route("POST", "/slack-installation/start", startSlackInstallation),
    route("GET", "/slack-installation", getSlackInstallation),
    route("GET", "/slack-emoji", getSlackEmojiList),
    route("PUT", "/slack-installation", putSlackInstallation),
    route("DELETE", "/slack-installation", deleteSlackInstallation),
    route("GET", "/model-providers", getModelProviders),
    route("PUT", "/model-providers/:provider", putModelProvider),
    route("GET", "/mcp-servers", getMcpServers),
    route("PUT", "/mcp-servers/:id", putMcpServer, portalOnly(MCP_SERVERS)),
    route("DELETE", "/mcp-servers/:id", deleteMcpServer),
    route("DELETE", "/model-providers/:provider", deleteModelProvider),
    route("GET", "/custom-providers", getCustomProviders),
    route("PUT", "/custom-providers/:provider", putCustomProvider),
    route("DELETE", "/custom-providers/:provider", deleteCustomProvider),
    route("PUT", "/scopes/:scope/:resource", putScopeConfig),
    route("GET", "/whoami", whoami, { agent: "anyone" }),
    route("GET", "/scopes", listAdminScopes, unattended("admin.sessions.read", "list the scope directory")),
    route("GET", "/scopes/:scope", getScopeConfig, UNLESS_ORG),
    route("GET", "/scopes/:scope/credential-usage", getCredentialUsageSummary, UNLESS_ORG),
    route("GET", "/resources", getAdminResources),
    route("GET", "/unattended-grants", (ctx) => listUnattendedGrants(ctx, routes)),
    route("GET", "/retention", retention),
    route("GET", "/spend", spend, { unattended: { grant: "admin.spend.read", summary: "read the org spend report" } }),
    route("GET", "/egress", egress, unattended("admin.egress.read", "read scope-labelled egress decisions")),
    route("GET", "/sessions", listAdminSessions, unattended("admin.sessions.read", "list conversation metadata")),
    route("GET", "/sessions/:id/llm", getAdminSessionLlm, PRIVATE),
    route("GET", "/sessions/:id", getAdminSession, unattended("admin.sessions.read", "read a conversation transcript")),
    route("GET", "/runs", listAdminRuns, unattended("admin.sessions.read", "read queued, in-flight, and recent runs")),
    route("GET", "/ambient-context/messages", listAmbientMessages, PRIVATE),
    route("GET", "/ambient-context", listAmbientContainers, PRIVATE),
    route("GET", "/ambient-judgments", listAmbientJudgments, PRIVATE),
    route("GET", "/ack-emoji-picks", listAckEmojiPicks, PRIVATE),
    route("GET", "/files/read", readAdminFile, unattended("admin.files.read", "read a stored file by ?id=")),
    route(
      "GET",
      "/files/download",
      downloadAdminFile,
      unattended("admin.files.read", "download a stored file by ?id="),
    ),
    route("POST", "/files/upload", uploadAdminFile),
    route("GET", "/files", listAdminFiles, unattended("admin.files.read", "list a scope's document store")),
    route("GET", "/errors", listAdminErrors, unattended("admin.sessions.read", "read error telemetry")),
    route("GET", "/audit", listAdminAudit, unattended("admin.audit.read", "read security audit events")),
    route("GET", "/security/flags", listSecurityFlags, PRIVATE),
    route("GET", "/crons", listAdminArtifacts, unattended("admin.crons.read", "list a scope's crons")),
    route("GET", "/deployments", listAdminArtifacts, PRIVATE),
    route("GET", "/skills", listAdminArtifacts, PRIVATE),
    route("PUT", "/crons/:id/runtime", putAdminCronRuntime),
    route("PUT", "/crons/:id/destination", putAdminCronDestination),
    route("GET", "/skills/:id", getAdminSkill, PRIVATE),
    route("DELETE", "/skills/:id", archiveAdminSkill),
    route("GET", "/memory/scopes", listMemoryScopes),
    route("GET", "/memory", adminMemory, UNLESS_ORG),
    route("POST", "/memory", adminMemory),
    route("PATCH", "/memory", adminMemory),
    route("DELETE", "/memory", adminMemory),
    route("GET", "/sandboxes/:scopeId", manageSandboxResources),
    route("POST", "/sandboxes/:scopeId", manageSandboxResources),
    route("GET", "/users", listUsers),
    route("GET", "/directory", searchDirectory),
    route("GET", "/keychain", listKeychainStatus, PRIVATE),
    route("GET", "/users/:principalId", getUserDetail, PRIVATE),
    route("POST", "/users/:principalId/reset", resetUserToBrandNew),
    route("GET", "/principal-links", listPrincipalLinks, portalOnly(LINKS)),
    route("POST", "/principal-links", createPrincipalLink, portalOnly(LINKS)),
    route("DELETE", "/principal-links/:principalId", deletePrincipalLink, portalOnly(LINKS)),
    route("POST", "/grants", createAdminGrant, portalOnly(GRANTS)),
    route("DELETE", "/grants/:principalId", revokeAdminGrant, portalOnly(GRANTS)),
    route("POST", "/users/invite", inviteTeammate),
    route("POST", "/external-users", inviteExternalUser),
    route("DELETE", "/external-users/:email", revokeExternalUser),
    route("POST", "/impersonate/stop", stopImpersonation, portalOnly(IMPERSONATE)),
    route("POST", "/impersonate", startImpersonation, portalOnly(IMPERSONATE)),
  ]),
];

export const adminRoutes: ReadonlyArray<Route<ApiCtx>> = routes.map((r) => ({ ...r, handle: timed(r.handle) }));
