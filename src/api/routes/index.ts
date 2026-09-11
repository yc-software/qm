import { sendJson } from "../http.ts";
import { type ApiCtx, type BaseCtx, type Route } from "./route.ts";
import { connectorRawRoutes, connectorRoutes } from "./connectors.ts";
import { deploymentRawRoutes, deploymentRoutes } from "./deployments.ts";
import { blobRoutes } from "./blobs.ts";
import { sessionStateRawRoutes } from "./session-state.ts";
import { loopItemEventsRawRoutes } from "./loop-item-events.ts";
import { webhookRawRoutes, webhookRoutes } from "./webhooks.ts";
import { turnRoutes } from "./turns.ts";
import { credentialRoutes } from "./credentials.ts";
import { brokerGitHttp, GIT_HTTP_BROKER_PREFIX } from "../git-http-broker.ts";
import { keychainRoutes } from "./keychain.ts";
import { secretDropRoutes } from "./secret-drop.ts";
import { adminRoutes } from "./admin.ts";
import { skillPackRoutes } from "./skill-packs.ts";
import { fileUploadRoutes } from "./file-uploads.ts";
import { surfaceRoutes } from "./surface.ts";
import { cronRoutes } from "./crons.ts";
import { loopRoutes } from "./loops.ts";
import { reachRoutes } from "./reach.ts";
import { directoryRoutes } from "./directory.ts";
import { contextRoutes } from "./context.ts";
import { pinRoutes } from "./pins.ts";
import { surfaceCacheRoutes } from "./surface-cache.ts";
import { environmentRoutes } from "./environments.ts";
import { emojiRoutes } from "./emoji.ts";
import { projectRoutes } from "./projects.ts";
import { contextPolicyRoutes } from "./context-policy.ts";
import { deploymentLayerRoutes } from "./deployment-layer.ts";
import { egressAuditRoutes } from "./egress-audit.ts";
import { slackEventRawRoutes } from "./slack-events.ts";
import { authBrokerRoutes } from "./auth-broker.ts";
import { loopItemRoutes } from "./loop-items.ts";
import { searchRoutes } from "./search.ts";
import { userModelAuthRoutes } from "./user-model-auth.ts";

export const rawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/healthz", auth: "public", handle: ({ res }) => sendJson(res, 200, { ok: true }) },
  ...slackEventRawRoutes,
  {
    match: (m, p) => (m === "GET" || m === "POST") && p.startsWith(GIT_HTTP_BROKER_PREFIX),
    auth: { aud: "credential-broker" },
    handle: brokerGitHttp,
  },
  { match: (_m, p) => p.startsWith(GIT_HTTP_BROKER_PREFIX), auth: { aud: "credential-broker" }, handle: brokerGitHttp },
  ...connectorRawRoutes,
  ...deploymentRawRoutes,
  ...blobRoutes,
  ...sessionStateRawRoutes,
  ...loopItemEventsRawRoutes,
  ...webhookRawRoutes,
];

export const apiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...searchRoutes,
  ...deploymentLayerRoutes,
  ...turnRoutes,
  ...credentialRoutes,
  ...keychainRoutes,
  ...secretDropRoutes,
  ...connectorRoutes,
  ...adminRoutes,
  ...skillPackRoutes,
  ...surfaceRoutes,
  ...fileUploadRoutes,
  ...projectRoutes,
  ...contextPolicyRoutes,
  ...cronRoutes,
  ...loopRoutes,
  ...reachRoutes,
  ...webhookRoutes,
  ...directoryRoutes,
  ...contextRoutes,
  ...pinRoutes,
  ...surfaceCacheRoutes,
  ...environmentRoutes,
  ...emojiRoutes,
  ...loopItemRoutes,
  ...deploymentRoutes,
  ...egressAuditRoutes,
  ...authBrokerRoutes,
  ...userModelAuthRoutes,
];
