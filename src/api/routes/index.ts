import { bootTenant, inBootTenant } from "../../tenants/boot.ts";
import { browserModelRoutes } from "./browser-model.ts";
import { sandboxModelRoutes } from "./sandbox-model.ts";
import { deploymentLiveSmokeRoutes } from "./deployment-live-smoke.ts";
import { composioRoutes } from "./composio.ts";
import { composioAuthorizeRoutes } from "./composio-authorize.ts";
import { composioCallbackRoutes } from "./composio-callback.ts";
import { composioTwitterMediaRoutes } from "./composio-twitter-media.ts";
import { composioProxyRoutes } from "./composio-proxy.ts";
import { loopIngressRoutes, loopIngressRawRoutes } from "./loop-ingress.ts";
import { sendJson } from "../http.ts";
import { type ApiCtx, type BaseCtx, type Route } from "./route.ts";
import { connectorRawRoutes, connectorRoutes } from "./connectors.ts";
import { appRawRoutes, appRoutes } from "./apps.ts";
import { appSharingRoutes } from "./app-sharing.ts";
import { blobRoutes, browserUploadRoutes } from "./blobs.ts";
import { webhookRawRoutes, webhookRoutes } from "./webhooks.ts";
import { runEventRoutes } from "./run-events.ts";
import { turnRoutes } from "./turns.ts";
import { webTurnRoutes } from "./web-turns.ts";
import { webEventRoutes } from "./web-events.ts";
import { webMeRoutes } from "./web-me.ts";
import { voiceRoutes } from "./voice.ts";
import { credentialRoutes } from "./credentials.ts";
import { brokerGitHttp, GIT_HTTP_BROKER_PREFIX } from "../git-http-broker.ts";
import { keychainRoutes } from "./keychain.ts";
import { secretDropRoutes } from "./secret-drop.ts";
import { memoryBrainRoutes } from "./memory-brain.ts";
import { adminRoutes } from "./admin.ts";
import { spendExport } from "./admin/spend.ts";
import { skillPackRoutes } from "./skill-packs.ts";
import { fileUploadRoutes } from "./file-uploads.ts";
import { surfaceRoutes } from "./surface.ts";
import { fileContentRoutes } from "./file-content.ts";
import { cronRoutes } from "./crons.ts";
import { loopRoutes } from "./loops.ts";
import { reachRoutes } from "./reach.ts";
import { directoryRoutes } from "./directory.ts";
import { contextRoutes } from "./context.ts";
import { pinRoutes } from "./pins.ts";
import { uiCanvasRoutes } from "./ui-canvas.ts";
import { surfaceCacheRoutes } from "./surface-cache.ts";
import { environmentRoutes } from "./environments.ts";
import { emojiRoutes } from "./emoji.ts";
import { projectRoutes } from "./projects.ts";
import { contextPolicyRoutes } from "./context-policy.ts";
import { deploymentLayerRoutes } from "./deployment-layer.ts";
import { egressAuditRoutes } from "./egress-audit.ts";
import { slackEventRawRoutes } from "./slack-events.ts";
import { partnerChatEventRawRoutes } from "./partner-chat-events.ts";
import { authBrokerRoutes } from "./auth-broker.ts";
import { inboxRoutes } from "./inbox.ts";
import { loopItemRoutes } from "./loop-items.ts";
import { searchRoutes } from "./search.ts";
import { userModelAuthRoutes } from "./user-model-auth.ts";
import { swarmRoutes } from "./swarms.ts";
import { personaRoutes } from "./personas.ts";

export const rawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "GET",
    path: "/healthz",
    auth: "public",
    tenant: "none",
    handle: ({ res, deps }) => sendJson(res, deps.draining?.aborted ? 503 : 200, { ok: !deps.draining?.aborted }),
  },
  {
    method: "GET",
    path: "/readyz",
    auth: "public",
    tenant: "none",
    handle: async ({ res, deps }) => {
      if (deps.draining?.aborted) return sendJson(res, 503, { ok: false });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Readiness deadline exceeded"));
        }, 1000);
      });
      try {
        await Promise.race([
          Promise.resolve().then(() => inBootTenant(bootTenant(), () => deps.checkReadiness?.(controller.signal))),
          deadline,
        ]);
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 503, { ok: false });
      } finally {
        clearTimeout(timer);
      }
    },
  },
  ...slackEventRawRoutes,
  ...partnerChatEventRawRoutes,
  { method: "GET", path: "/v1/spend/export", auth: "public", handle: spendExport },
  { match: (_m, p) => p.startsWith(GIT_HTTP_BROKER_PREFIX), auth: { aud: "credential-broker" }, handle: brokerGitHttp },
  ...connectorRawRoutes,
  ...appRawRoutes,
  ...blobRoutes,
  ...webhookRawRoutes,
  ...loopIngressRawRoutes,
];

function closedToNotebookOnly(routes: ReadonlyArray<Route<ApiCtx>>): Route<ApiCtx>[] {
  return routes.map((route) => ({
    ...route,
    handle: (ctx) =>
      ctx.method !== "GET" && ctx.capability?.memory?.notebookOnly
        ? sendJson(ctx.res, 403, {
            error: "forbidden",
            message: "a notebook-only turn can't create or change crons, loops or webhooks",
          })
        : route.handle(ctx),
  }));
}

export const apiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...browserModelRoutes,
  ...browserUploadRoutes,
  ...sandboxModelRoutes,
  ...swarmRoutes,
  ...personaRoutes,
  ...searchRoutes,
  ...deploymentLayerRoutes,
  ...deploymentLiveSmokeRoutes,
  ...turnRoutes,
  ...webTurnRoutes,
  ...webEventRoutes,
  ...webMeRoutes,
  ...voiceRoutes,
  ...runEventRoutes,
  ...credentialRoutes,
  ...keychainRoutes,
  ...secretDropRoutes,
  ...memoryBrainRoutes,
  ...connectorRoutes,
  ...composioRoutes,
  ...composioAuthorizeRoutes,
  ...composioCallbackRoutes,
  ...composioTwitterMediaRoutes,
  ...composioProxyRoutes,
  ...adminRoutes,
  ...skillPackRoutes,
  ...fileContentRoutes,
  ...surfaceRoutes,
  ...fileUploadRoutes,
  ...projectRoutes,
  ...contextPolicyRoutes,
  ...reachRoutes,
  ...closedToNotebookOnly([...cronRoutes, ...loopItemRoutes, ...loopRoutes, ...webhookRoutes, ...loopIngressRoutes]),
  ...directoryRoutes,
  ...contextRoutes,
  ...pinRoutes,
  ...uiCanvasRoutes,
  ...surfaceCacheRoutes,
  ...environmentRoutes,
  ...emojiRoutes,
  ...inboxRoutes,
  ...appRoutes,
  ...appSharingRoutes,
  ...egressAuditRoutes,
  ...authBrokerRoutes,
  ...userModelAuthRoutes,
];
