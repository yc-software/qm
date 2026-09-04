import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import bolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createDeduper, createThreadTracker } from "./lib.ts";
import { installDevIntrospection } from "./dev-introspection.ts";
import { setDefaultBotIdentity, createSurfaceHeaderEnsurer, type SurfaceHeaderClient } from "./delivery.ts";
import { NO_RETRY, type SlackPluginConfig, normalizeSlackApiUrl, slackPluginConfigFromEnv } from "./config.ts";
import { createCoreBridge } from "./core-bridge.ts";
import { createAckEmojiPicker } from "./ack-emoji.ts";
import { type BotIdentity, createDirectory } from "./directory.ts";
import { createMirror } from "./mirror.ts";
import { createConversationSerializer } from "./conversation-view.ts";
import { createApprovals } from "./approvals.ts";
import { createTurnHandler } from "./turn-handler.ts";
import { registerSlackEvents } from "./events.ts";
import { createSurfaceContextFulfiller } from "./surface-context.ts";
import { createDeliveryPoller } from "./deliveries.ts";
import { createDeferredAckReceiver } from "./deferred-ack.ts";
import { createHttpEventsReceiver } from "./http-events.ts";
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
const { App, LogLevel } = bolt;

export type { SlackCoreClient };
export type { SlackPluginConfig };
export { normalizeSlackApiUrl, slackPluginConfigFromEnv };

export async function startSlackPlugin(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
): Promise<{ stop(): Promise<void> }> {
  const EVENTS_MODE = cfg.eventsMode ?? "socket";
  if (!cfg.botToken) {
    throw new Error("Slack plugin needs botToken (SLACK_BOT_TOKEN, xoxb-…)");
  }
  if (EVENTS_MODE === "socket" && !cfg.appToken) {
    throw new Error("Slack plugin needs appToken (SLACK_APP_TOKEN, xapp-…) in socket events mode");
  }
  if (EVENTS_MODE === "http" && (!cfg.signingSecret || !cfg.eventsPort)) {
    throw new Error(
      "Slack plugin needs signingSecret (SLACK_SIGNING_SECRET) and eventsPort (SLACK_EVENTS_PORT) in http events mode",
    );
  }
  const BOT_TOKEN = cfg.botToken;
  const APP_TOKEN = cfg.appToken;
  const SLACK_API_URL = cfg.apiUrl ? normalizeSlackApiUrl(cfg.apiUrl) : undefined;
  const TRUSTED_FILE_HOST = SLACK_API_URL ? new URL(SLACK_API_URL).hostname : undefined;
  const CLIENT_OPTIONS = { ...NO_RETRY, ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}) } as const;
  const IDENTITY_TOKENS: Record<string, string | undefined> = {
    copilot: cfg.copilotBotToken,
  };
  const identityClients = new Map<string, WebClient>();
  function clientForIdentity(identity: string): WebClient {
    const token = IDENTITY_TOKENS[identity];
    if (!token) throw new Error(`no token for post identity "${identity}" (set its *_BOT_TOKEN env)`);
    let c = identityClients.get(identity);
    if (!c) {
      c = new WebClient(token, { ...CLIENT_OPTIONS });
      identityClients.set(identity, c);
    }
    return c;
  }
  let stopped = false;

  const ids: BotIdentity = {
    ownTeamId: "",
    botUserId: "",
    ownBotId: "",
    botHandle: "",
    ownWorkspaceUrl: "",
    identityMode: cfg.identityEmail === "0" ? "slack-id" : "email",
  };

  const ACK_OVERRIDE_CACHE_MS = 60_000;
  let ackOverrideCache: { names: string[] | null; fetchedAt: number } | undefined;
  function ackEmojiOverride(): readonly string[] | null {
    if (!ackOverrideCache || Date.now() - ackOverrideCache.fetchedAt >= ACK_OVERRIDE_CACHE_MS) {
      const prev = ackOverrideCache;
      ackOverrideCache = { names: prev?.names ?? null, fetchedAt: Date.now() };
      core
        .ackEmojiOverride()
        .then((names) => {
          ackOverrideCache = { names: names?.length ? names : null, fetchedAt: Date.now() };
        })
        .catch((err) => {
          swallow("slack: ack-emoji override read", err);
        });
    }
    return ackOverrideCache.names;
  }

  const EXTERNAL_PARTICIPANTS_CACHE_MS = 30_000;
  let externalParticipantsCache: { on: boolean; fetchedAt: number } | undefined;
  async function externalParticipantsEnabled(): Promise<boolean> {
    if (
      externalParticipantsCache &&
      Date.now() - externalParticipantsCache.fetchedAt < EXTERNAL_PARTICIPANTS_CACHE_MS
    ) {
      return externalParticipantsCache.on;
    }
    try {
      const on = await core.externalSlackParticipants();
      externalParticipantsCache = { on, fetchedAt: Date.now() };
      return on;
    } catch (err) {
      swallow("slack: surface-config read", err);
      return externalParticipantsCache?.on ?? false;
    }
  }

  const app = new App({
    token: BOT_TOKEN,
    receiver:
      EVENTS_MODE === "http"
        ? createHttpEventsReceiver({ signingSecret: cfg.signingSecret!, port: cfg.eventsPort! })
        : createDeferredAckReceiver({
            appToken: APP_TOKEN!,
            ...(cfg.logLevel ? { logLevel: cfg.logLevel } : {}),
            ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}),
          }),
    logLevel: (cfg.logLevel as any) ?? LogLevel.INFO,
    clientOptions: { ...CLIENT_OPTIONS },
  });
  setDefaultBotIdentity(cfg.botIdentity);
  const devIntrospection = installDevIntrospection(
    app,
    cfg.devIntrospection ? { enabled: true, port: cfg.devIntrospection.port } : {},
  );

  const deduper = createDeduper(1000);
  const threads = createThreadTracker();

  const bridge = createCoreBridge(core);
  const ackEmoji = createAckEmojiPicker(core, { candidatesOverride: ackEmojiOverride });
  const directory = createDirectory({
    core,
    ids,
    ...(cfg.userSnapshotTtlMs ? { userSnapshotTtlMs: cfg.userSnapshotTtlMs } : {}),
    ...(cfg.channelMembersTtlMs ? { channelMembersTtlMs: cfg.channelMembersTtlMs } : {}),
    ...(cfg.maxPrivateChannels ? { maxPrivateChannels: cfg.maxPrivateChannels } : {}),
    ...(cfg.userCacheTtlMs ? { userCacheTtlMs: cfg.userCacheTtlMs } : {}),
  });
  const mirror = createMirror({ core, ids, directory, externalParticipantsEnabled });
  const serializer = createConversationSerializer({
    ids,
    directory,
    externalParticipantsEnabled,
    ...(cfg.recentMessages ? { recentMessages: cfg.recentMessages } : {}),
  });
  const approvals = createApprovals({ core, bridge, directory, threads, ids });
  const ensureHeader = createSurfaceHeaderEnsurer({
    headerFacts: (scope) => core.surfaceHeaderFacts(scope as Parameters<typeof core.surfaceHeaderFacts>[0]),
    channelPinEnabled: (scope) =>
      core.channelHeaderPinEnabled(scope as Parameters<typeof core.channelHeaderPinEnabled>[0]),
    webUiPublicUrl: cfg.webUiPublicUrl,
    ids,
  });
  core.onScopeModelChanged((scope) => {
    const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    if (channel) ensureHeader(app.client as unknown as SurfaceHeaderClient, channel, scope, "channel");
  });
  core.onChannelHeaderPinChanged((scope) => {
    const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    if (channel) {
      ensureHeader(app.client as unknown as SurfaceHeaderClient, channel, scope, "channel", { pinNew: true });
      return;
    }
    if (!scope.startsWith("org:")) return;
    // The org-wide default changed: re-ensure every channel the bot is in. The
    // ensurer re-reads each scope's effective setting, so explicit per-channel
    // overrides come out unchanged.
    void (async () => {
      try {
        for await (const res of (app.client as any).paginate("conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 1000,
        }) as AsyncIterable<{ channels?: Array<{ id?: string; is_member?: boolean }> }>) {
          for (const c of res.channels ?? []) {
            if (!c?.id || !c.is_member) continue;
            ensureHeader(app.client as unknown as SurfaceHeaderClient, c.id, `channel:${c.id}`, "channel", {
              pinNew: true,
            });
          }
        }
      } catch (err) {
        console.error("[slack] channel header default sweep failed:", errMessage(err));
      }
    })();
  });
  const handler = createTurnHandler({
    bridge,
    directory,
    mirror,
    serializer,
    approvals,
    ackEmoji,
    ackEmojiCandidates: ackEmojiOverride,
    ids,
    threads,
    deduper,
    externalParticipantsEnabled,
    ...(devIntrospection ? { markEvent: () => devIntrospection.markEvent() } : {}),
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ensureHeader,
  });
  approvals.registerActions(app);
  registerSlackEvents(app, {
    handler,
    mirror,
    directory,
    ids,
    deduper,
    ...(cfg.webUiPublicUrl ? { webUiPublicUrl: cfg.webUiPublicUrl } : {}),
    ensureHeader,
  });
  const surfaceContext = createSurfaceContextFulfiller({
    core,
    bridge,
    directory,
    serializer,
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ...(cfg.userToken ? { userToken: cfg.userToken } : {}),
    clientOptions: CLIENT_OPTIONS,
  });
  const deliveries = createDeliveryPoller({ core, bridge, mirror, threads, clientForIdentity });

  let auth: any;
  try {
    auth = (await app.client.auth.test()) as any;
    ids.ownTeamId = auth.team_id ?? "";
    ids.botUserId = auth.user_id ?? "";
    ids.ownBotId = auth.bot_id ?? "";
    ids.botHandle = typeof auth.user === "string" ? auth.user : "";
    ids.ownWorkspaceUrl = typeof auth.url === "string" ? auth.url.replace(/\/+$/, "") : "";
    if (!ids.ownTeamId || !ids.botUserId) {
      throw new Error("auth.test returned no team_id/user_id — refusing to start (cannot classify members safely)");
    }
    if (!cfg.identityEmail) {
      ids.identityMode = await directory.resolveAutoIdentityMode(app.client);
      if (ids.identityMode === "slack-id") {
        console.warn(
          "[slack] no member emails visible (users:read.email scope missing?) — keying principals on Slack ids; add the scope or set SLACK_IDENTITY_EMAIL=1 to force email keying",
        );
      }
    }
    await directory.getUserSnapshot(app.client);
    await app.start();
  } catch (err) {
    stopped = true;
    await devIntrospection?.close().catch(swallowAs("slack: dev-introspection close on failed start", undefined));
    await app.stop().catch(swallowAs("slack: app.stop on failed start", undefined));
    throw err;
  }
  devIntrospection?.ready({ connectedAs: auth.user ?? "", botUserId: ids.botUserId, teamId: ids.ownTeamId });
  console.log(
    `[slack-plugin] connected as @${auth.user} (bot ${ids.botUserId}) in team ${auth.team} (${ids.ownTeamId}); in-process core`,
  );
  ackEmoji.refreshAckEmoji(app.client);
  ackEmojiOverride();

  let deliveriesPollInFlight = false;
  let deliveriesPollAgain = false;
  const drainDeliveries = (): void => {
    if (stopped) return;
    if (deliveriesPollInFlight) {
      deliveriesPollAgain = true;
      return;
    }
    deliveriesPollInFlight = true;
    void deliveries.pollDeliveries(app.client).finally(() => {
      deliveriesPollInFlight = false;
      if (deliveriesPollAgain) {
        deliveriesPollAgain = false;
        drainDeliveries();
      }
    });
  };
  const unsubscribeDeliveries = core.onDeliveryEnqueued(drainDeliveries);
  const deliveriesTimer = setInterval(drainDeliveries, 60_000);
  drainDeliveries();

  const contextRequestsInFlight = new Set<string>();

  const serviceContextRequest = (r: SurfaceContextRequest): void => {
    if (stopped || !r?.id || contextRequestsInFlight.has(r.id)) return;
    contextRequestsInFlight.add(r.id);
    void surfaceContext.fulfillSurfaceContext(app.client, r).finally(() => contextRequestsInFlight.delete(r.id));
  };
  const unsubscribeContextRequests = core.onContextRequest(serviceContextRequest);
  void core
    .pendingContextRequests()
    .then((pending) => pending.forEach(serviceContextRequest))
    .catch(swallowAs("slack: context request drain", undefined));

  return {
    async stop(): Promise<void> {
      if (stopped) {
        await app.stop();
        return;
      }
      stopped = true;
      clearInterval(deliveriesTimer);
      unsubscribeDeliveries();
      unsubscribeContextRequests();
      try {
        await app.stop();
      } finally {
        await devIntrospection?.close();
      }
    },
  };
}
