import {
  type SlackFile,
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
import type { AckGate } from "./deferred-ack.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { Mirror } from "./mirror.ts";
import type { SlackReactionEvent, TurnHandler } from "./turn-handler.ts";

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
    webUiPublicUrl?: string;
    ensureHeader?: (
      client: SurfaceHeaderClient,
      channel: string,
      scopeId: string,
      kind: "dm" | "channel",
      ensureOpts?: { pinNew?: boolean },
    ) => void;
  },
): void {
  const { handler, mirror, directory, ids, deduper } = deps;
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

  app.event("app_mention", async ({ event, body, client, context }: any) => {
    const e = event as any;
    const identity = await eventIdentity(client, e);
    const key = dedupeKey({
      event_id: (body as any)?.event_id,
      client_msg_id: e.client_msg_id,
      channel: e.channel,
      ts: e.ts,
    });
    await dispatch(
      key,
      {
        kind: "channel",
        channel: e.channel,
        userId: identity.userId,
        ...(identity.actor ? { actor: identity.actor } : {}),
        rawText: e.text ?? "",
        files: (e.files as SlackFile[]) ?? [],
        threadTs: e.thread_ts,
        ts: e.ts,
        ...(e.bot_id || e.subtype === "bot_message" ? { botAuthored: true } : {}),
        ackGate: context.ackGate as AckGate | undefined,
      },
      client,
    );
  });

  app.message(async ({ message, body, client, context }: any) => {
    const m = message as any;
    if (channelPrivacyChange(m)) {
      await forceDirectorySync(client, m.channel);
      return;
    }
    if (isGroupMembershipMessage(m)) {
      await forceDirectorySync(client);
      return;
    }
    const ackGate = context.ackGate as AckGate | undefined;
    if (m.subtype === "message_changed" && m.message) {
      if (shouldProcessMessage(m.message, ids.botUserId, ids.ownBotId))
        await mirrorMessageEvent({ ...m.message, channel: m.channel, channel_type: m.channel_type }, client, {
          editedAt: Date.now(),
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
            container: String(m.channel),
            ts: String(m.deleted_ts),
            deleted: true,
            ...(selfDelete ? { self: true } : {}),
          },
        ]);
      return;
    }
    if (!shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) return;

    if (m.channel_type === "im") {
      const identity = await eventIdentity(client, m);
      const key = dedupeKey({
        event_id: (body as any)?.event_id,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      await dispatch(
        key,
        {
          kind: "dm",
          channel: m.channel,
          userId: identity.userId,
          ...(identity.actor ? { actor: identity.actor } : {}),
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: m.text ?? "",
          files: (m.files as SlackFile[]) ?? [],
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
      if (m.channel_type === "mpim" && m.channel) syncForUnseenGroup(client, String(m.channel));
      const threadReply = isThreadReply(m);
      const isMention = mentionsBot(m.text ?? "", ids.botUserId);
      const willDispatch = threadReply && !isMention && (await botHasStakeInThread(client, m.channel, m.thread_ts));
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
        event_id: (body as any)?.event_id,
        client_msg_id: m.client_msg_id,
        channel: m.channel,
        ts: m.ts,
      });
      const identity = await eventIdentity(client, m);
      await dispatch(
        key,
        {
          kind: "channel",
          channel: m.channel,
          userId: identity.userId,
          ...(identity.actor ? { actor: identity.actor } : {}),
          ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
          rawText: m.text ?? "",
          files: (m.files as SlackFile[]) ?? [],
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

  app.event("member_joined_channel", async ({ event, body, client }: any) => {
    const e = event as { user?: string; channel?: string; event_ts?: string };
    if (
      deduper.seen(
        dedupeKey({ event_id: (body as { event_id?: string })?.event_id, channel: e.channel, ts: e.event_ts }),
      )
    )
      return;
    if (e.user === ids.botUserId) {
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
    app.event(evt, async ({ event, body, client }: any) => {
      const e = event as { channel?: { id?: string } | string; event_ts?: string };
      const channel = typeof e.channel === "string" ? e.channel : e.channel?.id;
      if (deduper.seen(dedupeKey({ event_id: (body as { event_id?: string })?.event_id, channel, ts: e.event_ts })))
        return;
      await forceDirectorySync(client, channel);
    });
  }

  app.event("member_left_channel", async ({ event, body, client }: any) => {
    const e = event as { channel?: string; user?: string; event_ts?: string };
    if (
      deduper.seen(
        dedupeKey({ event_id: (body as { event_id?: string })?.event_id, channel: e.channel, ts: e.event_ts }),
      )
    )
      return;
    const principalId = e.user ? (await directory.classifyUserCached(client, e.user)).actor.externalId : undefined;
    await forceDirectorySync(client, e.channel, principalId);
  });

  app.event("assistant_thread_started", async () => {});
  app.event("assistant_thread_context_changed", async () => {});

  app.event("reaction_added", async ({ event, body, client }: any) => {
    await handleReactionEvent(event as SlackReactionEvent, body as any, client, true);
  });
  app.event("reaction_removed", async ({ event, body, client }: any) => {
    await handleReactionEvent(event as SlackReactionEvent, body as any, client, false);
  });
}
