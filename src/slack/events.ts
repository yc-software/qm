import {
  channelPrivacyChange,
  createDeduper,
  dedupeKey,
  isGroupMembershipMessage,
  isThreadReply,
  mentionsBot,
  onBotJoinedChannel,
  type SurfaceHeaderClient,
  shouldProcessMessage,
} from "./lib.ts";
import { parseEventId, parseLifecycleEvent, parseMessageEvent, parseReactionEvent } from "./payloads.ts";
import type { AckGate } from "./deferred-ack.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { ActorAssertion } from "./identity.ts";
import type { DenyResponder } from "./allow-from.ts";
import { swallowAs } from "../util/errors.ts";
import type { Mirror } from "./mirror.ts";
import type { TurnHandler } from "./turn-handler.ts";

interface EventArgs {
  event: unknown;
  body: unknown;
  client: any;
  context: { ackGate?: AckGate };
}

interface MessageArgs {
  message: unknown;
  body: unknown;
  client: any;
  context: { ackGate?: AckGate };
}

export function registerSlackEvents(
  app: {
    event(name: string, handler: (args: any) => Promise<void>): void;
    message(handler: (args: any) => Promise<void>): void;
  },
  deps: {
    handler: TurnHandler;
    mirror: Mirror;
    directory: Directory;
    ids: BotIdentity;
    deduper: ReturnType<typeof createDeduper>;
    allowActor?: (actor: ActorAssertion) => boolean;
    denyResponder?: DenyResponder;
    webUiPublicUrl?: string;
    ensureHeader?: (
      client: SurfaceHeaderClient,
      channel: string,
      scopeId: string,
      kind: "dm" | "channel",
      ensureOpts?: { pinNew?: boolean },
    ) => void;
    inboxMessage?: (
      client: unknown,
      msg: { channel: string; ts: string; threadTs?: string; text?: string; senderSlackId?: string },
    ) => void;
  },
): void {
  const { handler, mirror, directory, ids, deduper, allowActor, denyResponder } = deps;
  const actorAllowed = async (client: any, userId: string | undefined): Promise<boolean> => {
    if (!allowActor) return true;
    if (!userId) return false;
    if (userId === ids.botUserId) return true;
    const { actor } = await directory.classifyUserCached(client, userId);
    return allowActor(actor);
  };
  const denyDirectApproach = async (
    client: any,
    opts: { channel: string; userId?: string; kind: "dm" | "channel"; threadTs?: string; isBot?: boolean },
  ): Promise<void> => {
    if (!denyResponder || !opts.userId || opts.isBot) return;
    if (!denyResponder.shouldSend(`${opts.channel}:${opts.userId}`)) return;
    if (opts.kind === "channel") {
      await client.chat
        .postEphemeral({ channel: opts.channel, user: opts.userId, text: denyResponder.message })
        .catch(swallowAs("slack: deny ephemeral", undefined));
    } else {
      await client.chat
        .postMessage({
          channel: opts.channel,
          text: denyResponder.message,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        })
        .catch(swallowAs("slack: deny reply", undefined));
    }
  };
  const { dispatch, handleReactionEvent, botHasStakeInThread } = handler;
  const { mirrorMessageEvent, pushSurfaceEvents } = mirror;
  const { syncForUnseenGroup, forceDirectorySync } = directory;
  const eventIdentity = async (
    client: any,
    event: { user?: string; bot_id?: string },
  ): Promise<{ userId: string; actor?: { externalId: string; isBot: true; displayName?: string } }> => {
    if (event.user) return { userId: event.user };
    if (!event.bot_id) return { userId: "" };
    try {
      const bot = (await client.bots.info({ bot: event.bot_id })).bot;
      if (bot?.user_id) return { userId: String(bot.user_id) };
      if (bot?.id === event.bot_id && bot.deleted !== true) {
        return {
          userId: event.bot_id,
          actor: {
            externalId: event.bot_id,
            isBot: true,
            ...(bot.name ? { displayName: String(bot.name) } : {}),
          },
        };
      }
    } catch {
      return { userId: event.bot_id };
    }
    return { userId: event.bot_id };
  };

  app.event("app_mention", async ({ event, body, client, context }: EventArgs) => {
    const e = parseMessageEvent(event);
    const identity = await eventIdentity(client, e);
    if (allowActor && !(await actorAllowed(client, identity.userId))) {
      if (deduper.seen(dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.ts }))) return;
      await denyDirectApproach(client, {
        channel: e.channel,
        userId: identity.userId,
        kind: "channel",
        isBot: Boolean(e.bot_id || identity.actor?.isBot),
      });
      return;
    }
    const key = dedupeKey({
      event_id: parseEventId(body),
      client_msg_id: e.client_msg_id,
      channel: e.channel,
      ts: e.ts,
    });
    const content = messageWithForwardedContent(e);
    await dispatch(
      key,
      {
        kind: "channel",
        channel: e.channel,
        userId: identity.userId,
        ...(identity.actor ? { actor: identity.actor } : {}),
        rawText: content.text,
        files: content.files,
        threadTs: e.thread_ts,
        ts: e.ts,
        ...(e.bot_id || e.subtype === "bot_message" ? { botAuthored: true } : {}),
        ackGate: context.ackGate,
      },
      client,
    );
  });

  app.message(async ({ message, body, client, context }: MessageArgs) => {
    const m = parseMessageEvent(message);
    const eventId = parseEventId(body);
    const privacyChange = channelPrivacyChange(m);
    if (privacyChange) {
      await forceDirectorySync(client, privacyChange.channel);
      return;
    }
    if (isGroupMembershipMessage(m)) {
      await forceDirectorySync(client);
      return;
    }
    const ackGate = context.ackGate;
    if (m.channel && m.ts && !m.subtype && !(m.bot_id || m.subtype === "bot_message")) {
      deps.inboxMessage?.(client, {
        channel: m.channel,
        ts: m.ts,
        ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
        ...(typeof m.text === "string" && m.text ? { text: m.text } : {}),
        ...(m.user ? { senderSlackId: m.user } : {}),
      });
    }
    if (m.subtype === "message_changed" && m.message?.subtype === "tombstone" && m.message.ts && m.channel) {
      await pushSurfaceEvents([{ container: m.channel, ts: m.message.ts, deleted: true }]);
      return;
    }
    if (!(await actorAllowed(client, m.user ?? m.message?.user ?? m.previous_message?.user))) {
      if (m.channel_type === "im" && shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) {
        await denyDirectApproach(client, {
          channel: m.channel,
          userId: m.user,
          kind: "dm",
          threadTs: m.thread_ts,
          isBot: Boolean(m.bot_id || m.subtype === "bot_message"),
        });
      }
      return;
    }
    if (m.subtype === "message_changed" && m.message) {
      const textChanged = m.previous_message?.text === undefined || m.previous_message.text !== m.message.text;
      if (shouldProcessMessage(m.message, ids.botUserId, ids.ownBotId))
        await mirrorMessageEvent({ ...m.message, channel: m.channel, channel_type: m.channel_type }, client, {
          ...(textChanged ? { editedAt: Date.now() } : {}),
          ...(m.channel_type === "im" ? { kind: "dm" as const } : {}),
        });
      return;
    }
    if (m.subtype === "message_deleted" && m.deleted_ts) {
      const type = m.channel_type;
      const prev = m.previous_message;
      const selfDelete = Boolean(
        prev && ((ids.botUserId && prev.user === ids.botUserId) || (ids.ownBotId && prev.bot_id === ids.ownBotId)),
      );
      if (m.channel && (type === "channel" || type === "group" || type === "mpim" || type === "im"))
        await pushSurfaceEvents([
          {
            container: m.channel,
            ts: m.deleted_ts,
            deleted: true,
            ...(prev?.thread_ts && prev.thread_ts !== m.deleted_ts ? { sub: prev.thread_ts } : {}),
            ...(selfDelete ? { self: true } : {}),
          },
        ]);
      return;
    }
    if (!shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) return;

    if (m.channel_type === "im") {
      const identity = await eventIdentity(client, m);
      const key = dedupeKey({
        event_id: eventId,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      const content = messageWithForwardedContent(m);
      await dispatch(
        key,
        {
          kind: "dm",
          channel: m.channel,
          userId: identity.userId,
          ...(identity.actor ? { actor: identity.actor } : {}),
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: content.text,
          files: content.files,
          threadTs: m.thread_ts,
          ts: m.ts,
          ...(m.bot_id || m.subtype === "bot_message" ? { botAuthored: true } : {}),
          ackGate,
        },
        client,
      );
      return;
    }

    if (m.channel_type === "channel" || m.channel_type === "group" || m.channel_type === "mpim") {
      if (m.channel_type === "mpim" && m.channel) syncForUnseenGroup(client, m.channel);
      const threadReply = isThreadReply(m);
      const isMention = mentionsBot(m.text ?? "", ids.botUserId);
      const threadTs = m.thread_ts;
      const willDispatch = Boolean(
        threadReply && !isMention && threadTs && (await botHasStakeInThread(client, m.channel, threadTs)),
      );
      await mirrorMessageEvent(m, client, willDispatch ? { handled: true } : {});
      if (!threadReply) return;
      if (isMention) return;
      if (!willDispatch) {
        console.error(
          `[slack-plugin] thread-follow skipped: no bot stake detected in thread ch=${m.channel} thread_ts=${m.thread_ts} ts=${m.ts}`,
        );
        return;
      }
      const key = dedupeKey({
        event_id: eventId,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      const identity = await eventIdentity(client, m);
      const content = messageWithForwardedContent(m);
      await dispatch(
        key,
        {
          kind: "channel",
          channel: m.channel,
          userId: identity.userId,
          ...(identity.actor ? { actor: identity.actor } : {}),
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: content.text,
          files: content.files,
          threadTs: m.thread_ts,
          ts: m.ts,
          unprompted: true,
          ...(m.bot_id || m.subtype === "bot_message" ? { botAuthored: true } : {}),
          ackGate,
        },
        client,
      );
    }
  });

  app.event("member_joined_channel", async ({ event, body, client }: EventArgs) => {
    const e = parseLifecycleEvent(event);
    if (deduper.seen(dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.eventTs }))) return;
    if (e.user === ids.botUserId) {
      if (allowActor) {
        await forceDirectorySync(client);
        return;
      }
      await onBotJoinedChannel({
        client,
        channel: e.channel,
        joinerUserId: e.user,
        botUserId: ids.botUserId,
        webUiPublicUrl: deps.webUiPublicUrl,
        syncDirectory: () => forceDirectorySync(client),
        ...(deps.ensureHeader
          ? {
              ensureHeader: (channel: string) =>
                deps.ensureHeader!(client as SurfaceHeaderClient, channel, `channel:${channel}`, "channel", {
                  pinNew: true,
                }),
            }
          : {}),
      });
    } else {
      await forceDirectorySync(client, e.channel);
    }
  });

  for (const evt of ["channel_created", "channel_rename", "channel_unarchive"] as const) {
    app.event(evt, async ({ event, body, client }: EventArgs) => {
      const e = parseLifecycleEvent(event);
      if (deduper.seen(dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.eventTs }))) return;
      await forceDirectorySync(client, e.channel);
    });
  }

  app.event("member_left_channel", async ({ event, body, client }: EventArgs) => {
    const e = parseLifecycleEvent(event);
    if (deduper.seen(dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.eventTs }))) return;
    const principalId = e.user ? (await directory.classifyUserCached(client, e.user)).actor.externalId : undefined;
    await forceDirectorySync(client, e.channel, principalId);
  });

  app.event("assistant_thread_started", async () => {});
  app.event("assistant_thread_context_changed", async () => {});

  app.event("reaction_added", async ({ event, body, client }: EventArgs) => {
    await handleReactionEvent(parseReactionEvent(event), parseEventId(body), client, true);
  });
  app.event("reaction_removed", async ({ event, body, client }: EventArgs) => {
    await handleReactionEvent(parseReactionEvent(event), parseEventId(body), client, false);
  });
}
