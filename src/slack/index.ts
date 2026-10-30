import { continueInPrivate } from "./private-continuation.ts";
import { externalSlackNamespace, type ExternalSlackAccess } from "./external-access.ts";
import { registerKeychainApprovalActions } from "./keychain-approvals.ts";
import { registerDeployAccessActions } from "./deploy-access.ts";
import { SlackPluginStartCleanupError } from "./tenant-runtimes.ts";
import { createSlackRateLimitNotice } from "./rate-limit-notice.ts";
import { createSlackHistoryReader } from "./history.ts";
import { reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { createEnvelopeStaging, type EnvelopeStaging } from "./envelope-staging.ts";
import bolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createDeduper, createThreadTracker } from "./lib.ts";
import { installDevIntrospection } from "./dev-introspection.ts";
import { setDefaultBotIdentity, createSurfaceHeaderEnsurer, type SurfaceHeaderClient } from "./delivery.ts";
import {
  NO_RETRY,
  HISTORY_NO_RETRY,
  type SlackPluginConfig,
  normalizeSlackApiUrl,
  slackPluginConfigFromEnv,
} from "./config.ts";
import { createTurnFlow } from "./turn-flow.ts";
import { createActorGate, createDenyResponder } from "./allow-from.ts";
import { createAckEmojiPicker } from "./ack-emoji.ts";
import { type BotIdentity, createDirectory } from "./directory.ts";
import { createMirror } from "./mirror.ts";
import { createConversationSerializer } from "./conversation-view.ts";
import { createApprovals } from "./approvals.ts";
import { createTurnHandler } from "./turn-handler.ts";
import { registerSlackEvents } from "./events.ts";
import { createSurfaceContextFulfiller } from "./surface-context.ts";
import { DEFAULT_SLACK_ACCOUNT, type DeliveryTenant } from "./deliveries.ts";
import { createDeferredAckReceiver } from "./deferred-ack.ts";
import { createHttpEventsReceiver } from "./http-events.ts";
import { parseChannelPage, parseLogLevel } from "./payloads.ts";
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
import type { AuthTestResponse } from "@slack/web-api";
import type { ReceiverEvent } from "@slack/bolt";
import type { DueEnvelope } from "./slack-tables.ts";
import type { TenantResolver } from "../tenants/resolver.ts";
import { currentTenant, withTenant } from "../tenants/context.ts";
const { App } = bolt;

export type { SlackCoreClient };
export type { SlackPluginConfig };
export { normalizeSlackApiUrl, slackPluginConfigFromEnv };

interface SlackAccountEntry {
  client: any;
  teamId: string;
  policy?: ExternalSlackAccess;
  inFlightRuns?: { add(id: string): void; delete(id: string): void };
}

const tenantAccounts = new Map<string, Map<string, SlackAccountEntry>>();

function accountsOf(tenant: string): Map<string, SlackAccountEntry> {
  let accounts = tenantAccounts.get(tenant);
  if (!accounts) {
    accounts = new Map();
    tenantAccounts.set(tenant, accounts);
  }
  return accounts;
}

function forgetAccount(tenant: string, id: string, client: unknown): void {
  const accounts = tenantAccounts.get(tenant);
  if (!accounts || accounts.get(id)?.client !== client) return;
  accounts.delete(id);
  if (!accounts.size) tenantAccounts.delete(tenant);
}

const TEAM_ADMISSION_TTL_MS = 60_000;

export function slackTeamOf(body: Record<string, unknown>): string | undefined {
  const authorizations = body.authorizations as Array<{ team_id?: unknown }> | undefined;
  const team = body.team as { id?: unknown } | undefined;
  const candidate =
    (Array.isArray(authorizations) ? authorizations[0]?.team_id : undefined) ?? body.team_id ?? team?.id;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

export interface SlackAccountRuntime {
  readonly accountId: string;
  readonly installationId?: string;
  readonly coreSingleton: boolean;
  readonly stagingAccount: string;
  readonly statusAccount: string;
  readonly delivery?: DeliveryTenant;
  readonly staging?: EnvelopeStaging;
  receive(event: ReceiverEvent): Promise<void>;
  replay(due: DueEnvelope): Promise<void>;
  reconcileStatus(): Promise<void>;
  reconcileAcks(): Promise<void>;
  refreshEmoji(now: number): void;
  serviceContextRequest(request: SurfaceContextRequest): void;
  scopeModelChanged(scope: string): void;
  channelHeaderPinChanged(scope: string): void;
  stop(): Promise<void>;
}

export async function startSlackPlugin(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
  resolver: TenantResolver,
): Promise<SlackAccountRuntime> {
  const EVENTS_MODE = cfg.eventsMode ?? "socket";
  if (!cfg.botToken) {
    throw new Error("Slack plugin needs botToken (SLACK_BOT_TOKEN, xoxb-…)");
  }
  if (!cfg.installationId && EVENTS_MODE === "socket" && !cfg.appToken) {
    throw new Error("Slack plugin needs appToken (SLACK_APP_TOKEN, xapp-…) in socket events mode");
  }
  if (!cfg.installationId && EVENTS_MODE === "http" && (!cfg.signingSecret || !cfg.eventsPort)) {
    throw new Error(
      "Slack plugin needs signingSecret (SLACK_SIGNING_SECRET) and eventsPort (SLACK_EVENTS_PORT) in http events mode",
    );
  }
  const TENANT = currentTenant();
  const BOT_TOKEN = cfg.botToken;
  const APP_TOKEN = cfg.appToken;
  const SLACK_API_URL = cfg.apiUrl ? normalizeSlackApiUrl(cfg.apiUrl) : undefined;
  const TRUSTED_FILE_HOST = SLACK_API_URL ? new URL(SLACK_API_URL).hostname : undefined;
  const CLIENT_OPTIONS = {
    ...NO_RETRY,
    attachOriginalToWebAPIRequestError: false,
    ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}),
  } as const;
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
  const CORE_SINGLETON = cfg.coreSingleton !== false;
  const ACCOUNT_LABEL = cfg.accountId ?? DEFAULT_SLACK_ACCOUNT;
  const accounts = accountsOf(TENANT);
  const ENVELOPE_REPLAY_RETRY_NUM = 99;
  const EMOJI_CATALOG_REFRESH_MS = 6 * 60 * 60_000;
  const configuredActorGate = createActorGate(cfg.allowFrom);
  const allowActor = cfg.externalAccess
    ? (actor: import("./identity.ts").ActorAssertion) =>
        !actor.isExternalGuest && !actor.isBot && (!configuredActorGate || configuredActorGate(actor))
    : configuredActorGate;
  const denyResponder = allowActor ? createDenyResponder(cfg.denyMessage) : undefined;

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
    if (cfg.externalAccess) return true;
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

  const stagingAccount = cfg.installationId ? `${ACCOUNT_LABEL}:${cfg.installationId}` : ACCOUNT_LABEL;
  const staging = core.stagedEnvelopes
    ? createEnvelopeStaging(core.stagedEnvelopes, { account: stagingAccount })
    : undefined;
  const admittedTeams = new Map<string, number>();
  const tenantFor = async (body: Record<string, unknown>): Promise<string | null> => {
    const team = slackTeamOf(body);
    if (!team) return null;
    if ((admittedTeams.get(team) ?? 0) > Date.now()) return TENANT;
    if ((await resolver.forSlackTeam(team)) !== TENANT) return null;
    if (admittedTeams.size >= 1000) admittedTeams.clear();
    admittedTeams.set(team, Date.now() + TEAM_ADMISSION_TTL_MS);
    return TENANT;
  };
  const receiver = () => {
    if (cfg.installationId) return { init() {}, start: async () => {}, stop: async () => {} } as bolt.Receiver;
    return EVENTS_MODE === "http"
      ? createHttpEventsReceiver({
          signingSecret: cfg.signingSecret!,
          port: cfg.eventsPort!,
          tenantFor,
          ...(cfg.ackCapMs !== undefined ? { capMs: cfg.ackCapMs } : {}),
          ...(staging ? { staging } : {}),
        })
      : createDeferredAckReceiver({
          appToken: APP_TOKEN!,
          tenantFor,
          ...(cfg.logLevel ? { logLevel: cfg.logLevel } : {}),
          ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}),
          ...(cfg.ackCapMs !== undefined ? { capMs: cfg.ackCapMs } : {}),
          ...(staging ? { staging } : {}),
        });
  };
  const app = new App({
    token: BOT_TOKEN,
    ignoreSelf: false,
    receiver: receiver(),
    logLevel: parseLogLevel(cfg.logLevel),
    clientOptions: { ...CLIENT_OPTIONS },
  });
  if (cfg.externalAccess)
    app.use(async ({ body, next }) => {
      const envelope = body as unknown as { team_id?: string; team?: { id?: string } };
      const teamId = envelope.team_id ?? envelope.team?.id;
      if (!ids.ownTeamId || teamId !== ids.ownTeamId) return;
      await next();
    });
  if (CORE_SINGLETON) setDefaultBotIdentity(cfg.botIdentity);
  const devIntrospection = installDevIntrospection(
    app,
    cfg.devIntrospection ? { enabled: true, port: cfg.devIntrospection.port } : {},
  );

  const deduper = createDeduper(1000);
  const threads = createThreadTracker();

  const flow = createTurnFlow(core);
  const ackEmoji = createAckEmojiPicker(core, { candidatesOverride: ackEmojiOverride });
  const directory = createDirectory({
    ...(cfg.externalAccess ? { externalAccess: cfg.externalAccess } : {}),
    core,
    ids,
    coreSingleton: CORE_SINGLETON && !cfg.externalAccess,
    ...(cfg.userSnapshotTtlMs ? { userSnapshotTtlMs: cfg.userSnapshotTtlMs } : {}),
    ...(cfg.channelMembersTtlMs ? { channelMembersTtlMs: cfg.channelMembersTtlMs } : {}),
    ...(cfg.maxPrivateChannels ? { maxPrivateChannels: cfg.maxPrivateChannels } : {}),
    ...(cfg.userCacheTtlMs ? { userCacheTtlMs: cfg.userCacheTtlMs } : {}),
  });
  const mirror = cfg.externalAccess
    ? { pushSurfaceEvents: async () => {}, mirrorMessageEvent: async () => {} }
    : createMirror({ core, ids, directory, externalParticipantsEnabled });
  const historyRateLimitOptions = {
    managed: Boolean(cfg.installationId && cfg.sharedServiceUrl?.trim()),
    ...(cfg.webUiPublicUrl ? { setupUrl: `${cfg.webUiPublicUrl.replace(/\/$/, "")}/admin/?setup=slack` } : {}),
  };
  const rateLimitNotice = createSlackRateLimitNotice({
    ...historyRateLimitOptions,
    client: new WebClient(BOT_TOKEN, { ...CLIENT_OPTIONS, ...HISTORY_NO_RETRY, timeout: 5000 }),
  });
  const historyApi = new WebClient(BOT_TOKEN, { ...CLIENT_OPTIONS, ...HISTORY_NO_RETRY });
  const historyClient = {
    conversations: Object.fromEntries(
      (["history", "replies"] as const).map((method) => [
        method,
        async (args: any) => {
          try {
            return await historyApi.conversations[method](args);
          } catch (error) {
            await rateLimitNotice.observe(error);
            throw error;
          }
        },
      ]),
    ) as Pick<typeof historyApi.conversations, "history" | "replies">,
  };
  const readHistory = createSlackHistoryReader({
    historyLimit: cfg.historyLimit,
    core,
    ids,
    historyClient,
    ...historyRateLimitOptions,
  });
  const serializer = createConversationSerializer({
    readHistory,
    historyRateLimitOptions,
    ids,
    directory,
    externalParticipantsEnabled,
    ...(cfg.recentMessages ? { recentMessages: cfg.recentMessages } : {}),
  });
  const approvals = createApprovals({ core, flow, directory, threads, externalAccess: !!cfg.externalAccess });
  registerKeychainApprovalActions(app, { core, directory, webUiPublicUrl: cfg.webUiPublicUrl });
  registerDeployAccessActions(app, { core, directory });
  const ensureHeader = createSurfaceHeaderEnsurer({
    headerFacts: (scope) => core.surfaceHeaderFacts(scope as Parameters<typeof core.surfaceHeaderFacts>[0]),
    channelPinEnabled: (scope) =>
      core.channelHeaderPinEnabled(scope as Parameters<typeof core.channelHeaderPinEnabled>[0]),
    webUiPublicUrl: cfg.webUiPublicUrl,
    ids,
  });
  const scopeModelChanged = (scope: string): void => {
    const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    if (channel) ensureHeader(app.client as unknown as SurfaceHeaderClient, channel, scope, "channel");
  };
  const channelHeaderPinChanged = (scope: string): void => {
    const channel = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    if (channel) {
      ensureHeader(app.client as unknown as SurfaceHeaderClient, channel, scope, "channel", { pinNew: true });
      return;
    }
    if (!scope.startsWith("org:")) return;
    void (async () => {
      try {
        for await (const res of app.client.paginate("conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 1000,
        })) {
          for (const c of parseChannelPage(res)) {
            if (!c?.id || !c.is_member) continue;
            ensureHeader(app.client as unknown as SurfaceHeaderClient, c.id, `channel:${c.id}`, "channel", {
              pinNew: true,
            });
          }
        }
      } catch (err) {
        reportFailure("slack: channel header default sweep", err);
      }
    })();
  };
  const statusClient = new WebClient(BOT_TOKEN, {
    ...CLIENT_OPTIONS,
    timeout: 5_000,
    rejectRateLimitedCalls: true,
  });
  const statusAccount = () => `${ids.ownTeamId}:${ids.botUserId}`;
  let statusSync: Promise<void> | undefined;
  const reconcileStatus = () => {
    statusSync ??= core.sessionStatus
      ?.reconcile(statusClient, statusAccount())
      .catch(swallowAs("slack: session status reconciliation", undefined))
      .finally(() => {
        statusSync = undefined;
      });
    return statusSync;
  };
  const continuePrivate = (runId: string, task: string) =>
    continueInPrivate(core, runId, task, (id) => accounts.get(id));
  const handler = createTurnHandler({
    accountId: ACCOUNT_LABEL,
    ...(cfg.externalAccess ? { externalAccess: cfg.externalAccess } : {}),
    continuePrivate,
    onEngaged: (runId, channel, threadTs) => {
      void core.sessionStatus
        ?.start(statusClient, statusAccount(), runId, channel, threadTs)
        .catch(swallowAs("slack: session status start", undefined))
        .finally(() => {
          void reconcileStatus();
        });
    },
    onSettled: () => {
      void reconcileStatus();
    },
    rateLimitNotice,
    readHistory,
    core,
    flow,
    directory,
    mirror,
    serializer,
    ackEmoji,
    ackEmojiCandidates: ackEmojiOverride,
    ids,
    threads,
    deduper,
    externalParticipantsEnabled,
    ...(allowActor ? { allowActor } : {}),
    ...(devIntrospection ? { markEvent: () => devIntrospection.markEvent() } : {}),
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ensureHeader,
  });
  approvals.registerActions(app);
  const inboxMessage = (
    client: unknown,
    msg: {
      channel: string;
      ts: string;
      threadTs?: string;
      text?: string;
      senderSlackId?: string;
      isDirectMessage: boolean;
    },
  ): void => {
    void (async () => {
      let senderEmail: string | undefined;
      if (msg.senderSlackId) {
        try {
          const actor = await directory.classifyActor(client, msg.senderSlackId);
          if (actor.externalId.includes("@")) senderEmail = actor.externalId;
        } catch (e) {
          swallow("slack: classify inbox message sender", e);
          senderEmail = undefined;
        }
      }
      await core.inboxSlackMessage({
        channel: msg.channel,
        ts: msg.ts,
        isDirectMessage: msg.isDirectMessage,
        ...(msg.threadTs ? { threadTs: msg.threadTs } : {}),
        ...(msg.text ? { text: msg.text } : {}),
        ...(senderEmail ? { senderEmail } : {}),
      });
    })().catch((e) => swallow("slack: forward message to inbox", e));
  };
  registerSlackEvents(app, {
    handler,
    mirror,
    directory,
    ids,
    deduper,
    ...(!cfg.externalAccess ? { inboxMessage } : {}),
    ...(allowActor ? { allowActor } : {}),
    ...(denyResponder ? { denyResponder } : {}),
    ...(cfg.webUiPublicUrl ? { webUiPublicUrl: cfg.webUiPublicUrl } : {}),
    backfillHistory: (client: unknown, channel: string) => readHistory(client, channel),
    ensureHeader,
  });
  const surfaceContext = createSurfaceContextFulfiller({
    historyLimit: cfg.historyLimit,
    rateLimitNotice,
    historyClient,
    readHistory,
    historyRateLimitOptions,
    core,
    directory,
    serializer,
    botToken: BOT_TOKEN,
    ...(TRUSTED_FILE_HOST ? { trustedFileHost: TRUSTED_FILE_HOST } : {}),
    ...(cfg.userToken ? { userToken: cfg.userToken } : {}),
    clientOptions: CLIENT_OPTIONS,
  });
  const delivery: DeliveryTenant | undefined =
    CORE_SINGLETON || cfg.externalAccess
      ? {
          clientForAccount: (id, teamId) => {
            const account = accounts.get(id);
            return account && (!teamId || account.teamId === teamId) ? account.client : undefined;
          },
          externalNamespace: (id) => {
            const account = accounts.get(id);
            return account?.policy ? externalSlackNamespace(account.teamId, account.policy) : undefined;
          },
          continuePrivate,
          flow,
          threads,
          clientForIdentity,
          ...(cfg.webUiPublicUrl ? { webUiPublicUrl: cfg.webUiPublicUrl } : {}),
        }
      : undefined;

  let auth: AuthTestResponse;
  try {
    auth = await app.client.auth.test();
    ids.ownTeamId = auth.team_id ?? "";
    ids.botUserId = auth.user_id ?? "";
    ids.ownBotId = auth.bot_id ?? "";
    ids.botHandle = typeof auth.user === "string" ? auth.user : "";
    ids.ownWorkspaceUrl = typeof auth.url === "string" ? auth.url.replace(/\/+$/, "") : "";
    if (!ids.ownTeamId || !ids.botUserId) {
      throw new Error("auth.test returned no team_id/user_id — refusing to start (cannot classify members safely)");
    }
    if ((await resolver.forSlackTeam(ids.ownTeamId)) !== TENANT)
      throw new Error(`Slack workspace ${ids.ownTeamId} does not belong to this tenant`);
    if (!cfg.identityEmail) {
      ids.identityMode = await directory.resolveAutoIdentityMode(app.client);
      if (ids.identityMode === "slack-id") {
        console.warn(
          "[slack] no member emails visible (users:read.email scope missing?) — keying principals on Slack ids; add the scope or set SLACK_IDENTITY_EMAIL=1 to force email keying",
        );
      }
    }
    await directory.getUserSnapshot(app.client);
    if (accounts.has(ACCOUNT_LABEL)) throw new Error(`Duplicate Slack account id: ${ACCOUNT_LABEL}`);
    accounts.set(ACCOUNT_LABEL, {
      client: app.client,
      inFlightRuns: flow.inFlightRuns,
      teamId: ids.ownTeamId,
      ...(cfg.externalAccess ? { policy: cfg.externalAccess } : {}),
    });
    await app.start();
  } catch (err) {
    forgetAccount(TENANT, ACCOUNT_LABEL, app.client);
    stopped = true;
    await devIntrospection?.close().catch(swallowAs("slack: dev-introspection close on failed start", undefined));
    try {
      await app.stop();
    } catch (cleanupError) {
      throw new SlackPluginStartCleanupError(err, cleanupError, async () => {
        await app.stop();
      });
    }
    throw err;
  }
  devIntrospection?.ready({ connectedAs: auth.user ?? "", botUserId: ids.botUserId, teamId: ids.ownTeamId });
  console.log(
    `[slack-plugin] account ${ACCOUNT_LABEL} connected as @${auth.user} (bot ${ids.botUserId}) in team ${auth.team} (${ids.ownTeamId}); in-process core`,
  );

  ackEmoji.refreshAckEmoji(app.client);
  ackEmojiOverride();

  let emojiPublishedAt = 0;
  const refreshEmoji = (now: number): void => {
    if (stopped || !CORE_SINGLETON || now - emojiPublishedAt < EMOJI_CATALOG_REFRESH_MS) return;
    emojiPublishedAt = now;
    void Promise.resolve(app.client.emoji.list())
      .then((res: { emoji?: Record<string, string> }) => {
        const emoji: Record<string, string> = {};
        for (const [name, url] of Object.entries(res.emoji ?? {})) {
          if (typeof url === "string" && !url.startsWith("alias:")) emoji[name] = url;
        }
        return core.publishEmojiCatalog(emoji);
      })
      .catch(swallowAs("slack: emoji catalog publish", undefined));
  };
  refreshEmoji(Date.now());

  const contextRequestsInFlight = new Set<string>();
  const serviceContextRequest = (r: SurfaceContextRequest): void => {
    if (stopped || !CORE_SINGLETON || !r?.id || contextRequestsInFlight.has(r.id)) return;
    contextRequestsInFlight.add(r.id);
    void surfaceContext
      .fulfillSurfaceContext(app.client, r)
      .catch(swallowAs("slack: context request fulfillment", undefined))
      .finally(() => contextRequestsInFlight.delete(r.id));
  };
  if (CORE_SINGLETON)
    void core
      .pendingContextRequests()
      .then((pending) => pending.forEach(serviceContextRequest))
      .catch(swallowAs("slack: context request drain", undefined));
  void reconcileStatus();

  const receive = (event: ReceiverEvent): Promise<void> => withTenant(TENANT, () => app.processEvent(event));
  return {
    accountId: ACCOUNT_LABEL,
    ...(cfg.installationId ? { installationId: cfg.installationId } : {}),
    coreSingleton: CORE_SINGLETON,
    stagingAccount,
    statusAccount: statusAccount(),
    ...(delivery ? { delivery } : {}),
    ...(staging ? { staging } : {}),
    receive,
    async replay(due) {
      await staging?.replay(due, (body, ackGate) =>
        receive({ body, ack: async () => {}, retryNum: ENVELOPE_REPLAY_RETRY_NUM, customProperties: { ackGate } }),
      );
    },
    reconcileStatus: async () => {
      await reconcileStatus();
    },
    async reconcileAcks() {
      await core.taskAcknowledgements
        ?.reconcile(app.client)
        .catch(swallowAs("slack: task ack reconciliation", undefined));
    },
    refreshEmoji,
    serviceContextRequest,
    scopeModelChanged: (scope) => {
      if (CORE_SINGLETON && !stopped) scopeModelChanged(scope);
    },
    channelHeaderPinChanged: (scope) => {
      if (CORE_SINGLETON && !stopped) channelHeaderPinChanged(scope);
    },
    async stop(): Promise<void> {
      if (stopped) {
        await app.stop();
        return;
      }
      stopped = true;
      forgetAccount(TENANT, ACCOUNT_LABEL, app.client);
      if (CORE_SINGLETON) setDefaultBotIdentity(undefined);
      try {
        await app.stop();
      } finally {
        await devIntrospection?.close();
      }
    },
  };
}
