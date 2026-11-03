import type { App } from "../../api/app-types.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../../reach/reach.ts";
import type { SurfaceCache } from "../../surface-cache/surface-cache.ts";
import { reportFailureAs } from "../../util/errors.ts";
import { isoFromTs } from "../../util/message-tag.ts";
import { partnerChatPrincipal } from "./adapter.ts";
import {
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatEvent,
  parsePartnerChatRef,
  verifyPartnerChat,
} from "./protocol.ts";

const SURFACE = "partner-chat";
const ENGAGED_THREAD_SCAN = 100;
const CONTEXT_DEFAULT_COUNT = 50;

type InboundApp = Pick<App, "turn" | "ingestSurfaceEvents" | "onContextRequestCreated" | "fulfillContextRequest">;

export function createPartnerChatInbound(deps: {
  secret: string;
  app: InboundApp;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  isInternalEmail: (email: string) => Promise<boolean>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = deps.surfaceCache;

  async function threadEngaged(container: string, thread: string): Promise<boolean> {
    const replies = await cache.readMessages(container, {
      surface: SURFACE,
      sub: thread,
      limit: ENGAGED_THREAD_SCAN,
      noFallback: true,
    });
    return replies.some((m) => m.self);
  }

  async function handle(timestamp: string | undefined, signature: string | undefined, rawBody: string) {
    if (!verifyPartnerChat(deps.secret, timestamp, signature, rawBody, now()))
      return { status: 401, body: { error: "unauthorized" } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = null;
    }
    const event = parsePartnerChatEvent(parsed);
    if (!event) return { status: 400, body: { error: "bad_request" } };
    const { message, chat } = event;
    const humans = await Promise.all(
      chat.members
        .filter((m) => !m.bot)
        .map(async (m) => partnerChatPrincipal(m, await deps.isInternalEmail(m.email?.trim().toLowerCase() ?? ""))),
    );
    if (humans.some((p) => p.isExternalGuest)) return { status: 200, body: { ok: true } };
    const self = message.user.bot === true;
    const author = partnerChatPrincipal(message.user, !self);
    const thread = event.thread_id ?? undefined;
    const container = partnerChatRef({ account: event.account, kind: chat.kind, chat: chat.id });
    const ts = partnerChatTs(message.created_at, message.id);
    const addressed =
      event.type === "message.created" &&
      !self &&
      (chat.kind === "dm" ||
        message.mentions_agent ||
        (thread !== undefined && (await threadEngaged(container, thread))));
    await deps.app.ingestSurfaceEvents(
      [
        {
          surface: SURFACE,
          container,
          ts,
          sub: thread ?? null,
          authorId: author.externalId,
          ...(author.displayName ? { authorName: author.displayName } : {}),
          text: message.body,
          ...(self ? { self: true, bot: true } : {}),
          ...(message.mentions_agent ? { mentionsSelf: true } : {}),
          ...(addressed ? { handled: true } : {}),
          ...(event.type === "message.updated" ? { editedAt: now() } : {}),
          ...(event.type === "message.deleted" ? { deleted: true } : {}),
          createdAt: Date.parse(message.created_at),
          members: humans.map((p) => p.externalId),
          ...(chat.name ? { containerName: chat.name } : {}),
          kind: chat.kind,
        },
      ],
      SURFACE,
    );
    if (!addressed) return { status: 200, body: { ok: true } };
    const threadRef = partnerChatRef({
      account: event.account,
      kind: chat.kind,
      chat: chat.id,
      ...(thread ? { thread } : {}),
    });
    await deps.app.turn({
      surface: SURFACE,
      actor: author,
      surfaceOrigin: {
        author: { surface: SURFACE, account: event.account, id: message.user.id },
        workspace: event.account,
        ...(thread ? { replyThread: thread } : {}),
        audience: "internal",
      },
      conversation: {
        kind: chat.kind,
        threadRef,
        ...(chat.kind === "group" ? { channelRef: container, isPrivate: true } : {}),
        ...(chat.name ? { channelName: chat.name } : {}),
        audience: humans,
      },
      deliveryTarget: threadRef,
      text: message.body,
      liveActor: true,
      triggerTs: ts,
      async: true,
      redeliveryKey: `${SURFACE}:${event.account}:${chat.id}:${message.id}`,
    });
    return { status: 200, body: { ok: true } };
  }

  async function answerContext(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    const ref = query.conversationTarget ? parsePartnerChatRef(query.conversationTarget) : null;
    if (!ref) return { messages: [], note: "this conversation can't be read" };
    const container = partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat });
    const rows = await cache.readMessages(container, {
      surface: SURFACE,
      ...(ref.thread ? { sub: ref.thread } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: query.count ?? CONTEXT_DEFAULT_COUNT,
      noFallback: true,
    });
    const match = query.match?.toLowerCase();
    const shown = rows.filter((m) => !match || m.text.toLowerCase().includes(match));
    return {
      messages: shown.map((m) => ({
        ts: m.ts,
        ...(m.sub ? { threadTs: m.sub } : {}),
        author: m.authorName ?? m.authorId ?? "",
        time: isoFromTs(m.ts),
        text: m.text,
      })),
      selfTs: shown.filter((m) => m.self).map((m) => m.ts),
    };
  }

  deps.app.onContextRequestCreated((request) => {
    if (request.source !== SURFACE) return;
    void answerContext(request.query)
      .then((result) => deps.app.fulfillContextRequest(request.id, { result }))
      .catch(reportFailureAs("partner-chat: answer context request", undefined));
  });

  return { handle };
}
