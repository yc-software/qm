import type { App } from "../../api/app-types.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../../reach/reach.ts";
import type { ActorAssertion, Destination, TurnResult } from "../../types.ts";
import type { SurfaceCache } from "../../surface-cache/surface-cache.ts";
import { inTenant } from "../../tenants/claim.ts";
import { errMessage, reportFailureAs } from "../../util/errors.ts";
import type { AddressFetch } from "../../util/network.ts";
import { buildContextWindow, detectInputs } from "../context-window.ts";
import { buildReactionTurnText, shouldSurfaceReaction } from "../reactions.ts";
import { partnerChatPrincipal } from "./adapter.ts";
import type { PartnerChatActionClick } from "./approvals.ts";
import type { PartnerChatClient } from "./client.ts";
import { stagePartnerChatFiles } from "./files.ts";
import {
  PARTNER_CHAT,
  chatContainer,
  findMessage,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatEvent,
  parsePartnerChatRef,
  verifyPartnerChat,
  type PartnerChatEvent,
  type PartnerChatActionEvent,
  type PartnerChatReactionEvent,
} from "./protocol.ts";
import type { PartnerChatTurns } from "./turns.ts";

const CONTEXT_SCAN = 500;
const CONTEXT_DEFAULT_COUNT = 100;

function eventContainer(event: Pick<PartnerChatEvent, "account" | "chat">): string {
  return chatContainer({ account: event.account, kind: event.chat.kind, chat: event.chat.id });
}

type InboundApp = Pick<
  App,
  "turn" | "ingestSurfaceEvents" | "onContextRequestCreated" | "fulfillContextRequest" | "tenantFor"
>;

export function createPartnerChatInbound(deps: {
  secret: string;
  client: PartnerChatClient;
  stageBlob: (bytes: Uint8Array) => Promise<{ blobId: string }>;
  storageFetch?: AddressFetch;
  app: InboundApp;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  isInternalEmail: (email: string) => Promise<boolean>;
  unansweredReply: (result: TurnResult, destination: Destination, idempotencyKey: string) => Promise<void>;
  turns: Pick<PartnerChatTurns, "start">;
  onAction: (click: PartnerChatActionClick) => Promise<void>;
  registerGroup: (groupId: string, principalIds: readonly string[]) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = deps.surfaceCache;

  async function followedThread(container: string, thread: string) {
    const [root, [lastReply]] = await Promise.all([
      findMessage(cache, container, thread),
      cache.readMessages(container, { surface: PARTNER_CHAT, sub: thread, self: true, limit: 1, noFallback: true }),
    ]);
    if (!root?.self && !lastReply) return undefined;
    return { ...(root?.self ? { opener: root.text } : {}), ...(lastReply ? { lastReplyTs: lastReply.ts } : {}) };
  }

  async function threadDetection(
    container: string,
    thread: string,
    followed: { opener?: string; lastReplyTs?: string },
    triggerTs: string,
  ) {
    const unanswered = await cache.readMessages(container, {
      surface: PARTNER_CHAT,
      sub: thread,
      ...(followed.lastReplyTs ? { after: followed.lastReplyTs } : {}),
      noFallback: true,
    });
    return detectInputs(
      unanswered.map((m) => ({
        name: m.authorName ?? m.authorId ?? "",
        text: m.text,
        ...(m.bot ? { isBot: true } : {}),
        ...(m.self ? { isSelf: true } : {}),
        ...(m.ts === triggerTs ? { isTrigger: true } : {}),
      })),
      followed.opener,
    );
  }

  async function handle(timestamp: string | undefined, signature: string | undefined, rawBody: string) {
    if (!verifyPartnerChat(deps.secret, timestamp, signature, rawBody, now()))
      return { status: 401, body: { error: "unauthorized" } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      return { status: 400, body: { error: "invalid_json", detail: errMessage(e) } };
    }
    const result = parsePartnerChatEvent(parsed);
    if (!result.success)
      return {
        status: 400,
        body: { error: "bad_request", issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      };
    const event = result.data;
    const tenant = await deps.app.tenantFor("partner_chat", event.account);
    if (!tenant) {
      console.log(`[partner-chat] ignoring an event for account ${event.account}: no serving workspace is bound to it`);
      return { status: 404, body: { error: "unknown_account" } };
    }
    return inTenant(tenant, (): Promise<{ status: number; body: Record<string, unknown> }> => {
      switch (event.type) {
        case "reaction.added":
        case "reaction.removed":
          return acceptReaction(event);
        case "action.invoked":
          return acceptAction(event);
        default:
          return accept(event);
      }
    });
  }

  async function participants(event: Pick<PartnerChatEvent, "account" | "chat">, actorId: string) {
    const { chat } = event;
    const members = chat.members.filter((m) => !m.bot);
    const botActor = chat.members.some((m) => m.bot && m.id === actorId);
    if (chat.kind === "dm" && (members.length !== 1 || (!botActor && members[0]!.id !== actorId))) {
      console.log(
        `[partner-chat] ignoring dm ${chat.id}: it lists ${members.length} non-bot member(s), and a dm must list only its one person`,
      );
      return { ignored: "not_one_to_one" } as const;
    }
    const humans = await Promise.all(
      members.map(async (m) =>
        partnerChatPrincipal(m, await deps.isInternalEmail(m.email?.trim().toLowerCase() ?? "")),
      ),
    );
    const listed = chat.members.find((m) => m.id === actorId);
    const guests = humans.filter((p) => p.isExternalGuest).length;
    if (guests || !listed) {
      console.log(
        `[partner-chat] ignoring chat ${chat.id}: ${guests} member(s) not vouched for as internal, author listed: ${Boolean(listed)}`,
      );
      return { ignored: "unvouched_participants" } as const;
    }
    if (chat.kind === "group")
      await deps.registerGroup(
        eventContainer(event),
        humans.map((p) => p.externalId),
      );
    const actor = listed.bot ? partnerChatPrincipal(listed, false) : humans[members.indexOf(listed)]!;
    return { humans, listed, actor };
  }

  function turnFrame(
    event: Pick<PartnerChatEvent, "account" | "chat">,
    actor: ActorAssertion,
    actorId: string,
    humans: ActorAssertion[],
    replyThread: string | undefined,
  ) {
    const { chat } = event;
    const container = eventContainer(event);
    const replyTarget = partnerChatRef({
      account: event.account,
      kind: chat.kind,
      chat: chat.id,
      ...(replyThread ? { thread: replyThread } : {}),
    });
    return {
      surface: PARTNER_CHAT,
      actor,
      surfaceOrigin: {
        author: { surface: PARTNER_CHAT, account: event.account, id: actorId },
        workspace: event.account,
        ...(replyThread ? { replyThread } : {}),
        audience: "internal" as const,
      },
      conversation: {
        kind: chat.kind,
        threadRef: replyTarget,
        ...(chat.kind === "group" ? { channelRef: container, isPrivate: true } : {}),
        ...(chat.name ? { channelName: chat.name } : {}),
        audience: humans,
      },
      deliveryTarget: replyTarget,
      ...(chat.kind === "group" && replyTarget !== container
        ? {
            deliveryCandidates: [
              { target: replyTarget, label: "this thread" },
              { target: container, label: chat.name ? `${chat.name} (the whole chat)` : "the whole chat" },
            ],
          }
        : {}),
    };
  }

  async function acceptAction(event: PartnerChatActionEvent) {
    const { chat, action } = event;
    const who = action.user.bot ? ({ ignored: "bot_action" } as const) : await participants(event, action.user.id);
    if ("ignored" in who) return { status: 200, body: { ok: true, ignored: who.ignored } };
    await deps.onAction({
      eventId: event.event_id,
      account: event.account,
      kind: chat.kind,
      chat: chat.id,
      ...(event.thread_id ? { thread: event.thread_id } : {}),
      messageId: event.message.id,
      actionId: action.id,
      userId: action.user.id,
      actor: who.actor,
    });
    return { status: 200, body: { ok: true } };
  }

  async function acceptReaction(event: PartnerChatReactionEvent) {
    const { message, chat, reaction } = event;
    const added = event.type === "reaction.added";
    if (reaction.user.bot) return { status: 200, body: { ok: true, ignored: "bot_reaction" } };
    const who = await participants(event, reaction.user.id);
    if ("ignored" in who) return { status: 200, body: { ok: true, ignored: who.ignored } };
    const reactor = who.actor;
    const container = eventContainer(event);
    const isDM = chat.kind === "dm";
    const onBotMessage =
      (message.app_post && message.user.bot === true) ||
      (await findMessage(cache, container, message.id, { self: true })) !== undefined;
    const onFollowedRoot =
      !isDM && !onBotMessage && !event.thread_id && (await followedThread(container, message.id)) !== undefined;
    const surfaces = shouldSurfaceReaction({
      itemType: "message",
      reactorId: reaction.user.id,
      botUserId: "",
      isDM,
      onBotMessage,
      onFollowedRoot,
    });
    console.log(
      `[partner-chat] heard reaction ${added ? "+" : "-"}:${reaction.name}: in chat ${chat.id} on message ${message.id} → ${surfaces ? "turn" : "no stake"}`,
    );
    if (!surfaces) return { status: 200, body: { ok: true, ignored: "no_stake" } };
    const authorName = message.user.name?.trim();
    const replyThread = event.thread_id ?? (chat.kind === "group" ? message.id : undefined);
    await deps.turns.start({
      where: {
        account: event.account,
        kind: chat.kind,
        chat: chat.id,
        ...(replyThread ? { thread: replyThread } : {}),
      },
      authorId: reaction.user.id,
      trigger: partnerChatTs(message.created_at, message.id),
      unprompted: true,
      synthetic: true,
      body: {
        ...turnFrame(event, reactor, reaction.user.id, who.humans, replyThread),
        text: buildReactionTurnText({
          surfaceLabel: "Chat",
          reactorName: reactor.displayName || "Someone",
          emoji: reaction.name,
          added,
          onBotMessage,
          ...(!onBotMessage && authorName && message.user.id !== reaction.user.id ? { authorName } : {}),
          ...(message.body ? { messageText: message.body } : {}),
        }),
        redeliveryKey: `${PARTNER_CHAT}:${event.account}:${chat.id}:reaction:${event.event_id}`,
      },
    });
    return { status: 200, body: { ok: true } };
  }

  async function accept(event: PartnerChatEvent) {
    const { message, chat } = event;
    const who = await participants(event, message.user.id);
    if ("ignored" in who) return { status: 200, body: { ok: true, ignored: who.ignored } };
    const { humans, listed, actor: author } = who;
    const bot = listed.bot === true;
    const thread = event.thread_id ?? undefined;
    const container = eventContainer(event);
    const appPost = bot && message.app_post;
    const own = appPost
      ? await findMessage(cache, container, message.id, { self: true, includeDeleted: true })
      : undefined;
    if (appPost && (event.type === "message.created" || !own)) {
      console.log(
        `[partner-chat] ignoring chat ${chat.id} message ${message.id}: it echoes one of the agent's own posts`,
      );
      return { status: 200, body: { ok: true, ignored: "own_message" } };
    }
    const ts = own?.ts ?? partnerChatTs(message.created_at, message.id);
    const startsTurn = event.type === "message.created" && !bot;
    const direct = chat.kind === "dm" || message.mentions_agent;
    const followed =
      startsTurn && !direct && thread !== undefined ? await followedThread(container, thread) : undefined;
    const addressed = startsTurn && (direct || followed !== undefined);
    await deps.app.ingestSurfaceEvents(
      [
        {
          surface: PARTNER_CHAT,
          container,
          ts,
          sub: own ? (own.sub ?? null) : (thread ?? null),
          authorId: own?.authorId ?? author.externalId,
          ...(!own && author.displayName ? { authorName: author.displayName } : {}),
          text: message.body,
          ...(own ? { self: true, handled: true } : {}),
          ...(bot ? { bot: true } : {}),
          ...(message.mentions_agent ? { mentionsSelf: true } : {}),
          ...(addressed ? { handled: true } : {}),
          ...(event.type === "message.updated" ? { editedAt: now() } : {}),
          ...(event.type === "message.deleted" ? { deleted: true } : {}),
          createdAt: own?.createdAt ?? Date.parse(message.created_at),
          members: humans.map((p) => p.externalId),
          ...(chat.name ? { containerName: chat.name } : {}),
          kind: chat.kind,
        },
      ],
      PARTNER_CHAT,
    );
    if (!addressed) return { status: 200, body: { ok: true } };
    const replyThread = thread ?? (chat.kind === "group" ? message.id : undefined);
    const frame = turnFrame(event, author, message.user.id, humans, replyThread);
    const replyTarget = frame.deliveryTarget;
    const staged = message.files.length
      ? await stagePartnerChatFiles(
          deps.client,
          event.account,
          message.files,
          deps.stageBlob,
          author.displayName,
          deps.storageFetch,
        )
      : undefined;
    if (event.protocol === 2) {
      await deps.turns.start({
        where: {
          account: event.account,
          kind: chat.kind,
          chat: chat.id,
          ...(replyThread ? { thread: replyThread } : {}),
        },
        authorId: message.user.id,
        trigger: ts,
        body: {
          ...frame,
          text: message.body,
          ...(staged?.attachments.length ? { attachments: staged.attachments } : {}),
          ...(staged?.issues.length ? { inboundNotes: staged.issues } : {}),
          ...(followed && thread ? await threadDetection(container, thread, followed, ts) : {}),
          redeliveryKey: `${PARTNER_CHAT}:${event.account}:${chat.id}:${message.id}`,
        },
        ...(followed && thread ? { unprompted: true } : {}),
      });
      return { status: 200, body: { ok: true } };
    }
    const queued = await deps.app.turn({
      ...frame,
      text: message.body,
      ...(staged?.attachments.length ? { attachments: staged.attachments } : {}),
      ...(staged?.issues.length ? { inboundNotes: staged.issues } : {}),
      ...(followed && thread
        ? {
            origin: { kind: "ambient" as const, entryTs: ts, live: true },
            ...(await threadDetection(container, thread, followed, ts)),
          }
        : { origin: { kind: "human" as const, messageTs: ts } }),
      async: true,
      redeliveryKey: `${PARTNER_CHAT}:${event.account}:${chat.id}:${message.id}`,
    });
    const destination = {
      type: PARTNER_CHAT,
      target: replyTarget,
      account: { id: event.account, workspace: event.account },
    };
    if (!queued.runId)
      await deps.unansweredReply(
        queued,
        destination,
        `notice:${PARTNER_CHAT}:${event.account}:${chat.id}:${message.id}`,
      );
    return { status: 200, body: { ok: true } };
  }

  async function answerContext(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    const ref = query.conversationTarget ? parsePartnerChatRef(query.conversationTarget) : null;
    if (!ref) return { messages: [], note: "this conversation can't be read" };
    const container = chatContainer(ref);
    const replies = await cache.readMessages(container, {
      surface: PARTNER_CHAT,
      ...(ref.thread ? { sub: ref.thread } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: CONTEXT_SCAN,
      noFallback: true,
    });
    const root =
      ref.thread && replies.length < CONTEXT_SCAN ? await findMessage(cache, container, ref.thread) : undefined;
    const scan = root && (!query.before || root.ts < query.before) ? [root, ...replies] : replies;
    return buildContextWindow(
      scan.map((m) => ({
        ts: m.ts,
        name: m.authorName ?? m.authorId ?? "",
        text: m.text,
        ...(m.self ? { isSelf: true } : {}),
        ...(m.sub ? { parentTs: m.sub } : {}),
      })),
      {
        count: query.count ?? CONTEXT_DEFAULT_COUNT,
        ...(query.match ? { match: query.match } : {}),
        scanHasMore: replies.length === CONTEXT_SCAN,
      },
    );
  }

  deps.app.onContextRequestCreated((request) => {
    if (request.source !== PARTNER_CHAT) return;
    void answerContext(request.query)
      .then((result) => deps.app.fulfillContextRequest(request.id, { result }))
      .catch(reportFailureAs("partner-chat: answer context request", undefined));
  });

  return { handle };
}
