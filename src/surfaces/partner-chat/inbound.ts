import type { App } from "../../api/app-types.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../../reach/reach.ts";
import type { Destination } from "../../types.ts";
import type { SurfaceCache } from "../../surface-cache/surface-cache.ts";
import { reportFailureAs } from "../../util/errors.ts";
import { buildContextWindow } from "../../slack/conversation.ts";
import { partnerChatPrincipal } from "./adapter.ts";
import {
  findOwnMessage,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatEvent,
  parsePartnerChatRef,
  verifyPartnerChat,
} from "./protocol.ts";

const SURFACE = "partner-chat";
const CONTEXT_SCAN = 500;
const CONTEXT_DEFAULT_COUNT = 100;

type InboundApp = Pick<App, "turn" | "ingestSurfaceEvents" | "onContextRequestCreated" | "fulfillContextRequest">;

export function createPartnerChatInbound(deps: {
  secret: string;
  app: InboundApp;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  isInternalEmail: (email: string) => Promise<boolean>;
  followReply?: (runId: string, destination: Destination) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = deps.surfaceCache;

  async function threadEngaged(container: string, thread: string): Promise<boolean> {
    const mine = await cache.readMessages(container, {
      surface: SURFACE,
      sub: thread,
      self: true,
      limit: 1,
      noFallback: true,
    });
    return mine.length > 0 || (await findOwnMessage(cache, container, thread)) !== undefined;
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
    const result = parsePartnerChatEvent(parsed);
    if (!result.success)
      return {
        status: 400,
        body: { error: "bad_request", issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      };
    const event = result.data;
    const { message, chat } = event;
    const members = chat.members.filter((m) => !m.bot);
    const humans = await Promise.all(
      members.map(async (m) =>
        partnerChatPrincipal(m, await deps.isInternalEmail(m.email?.trim().toLowerCase() ?? "")),
      ),
    );
    const self = message.user.bot === true;
    const authorAt = members.findIndex((m) => m.id === message.user.id);
    const guests = humans.filter((p) => p.isExternalGuest).length;
    if (guests || (!self && authorAt < 0)) {
      console.log(
        `[partner-chat] ignoring chat ${chat.id}: ${guests} member(s) not vouched for as internal, author listed: ${self || authorAt >= 0}`,
      );
      return { status: 200, body: { ok: true, ignored: "unvouched_participants" } };
    }
    const author = self ? partnerChatPrincipal(message.user, false) : humans[authorAt]!;
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
    const replyThread = thread ?? (chat.kind === "group" ? message.id : undefined);
    const replyTarget = partnerChatRef({
      account: event.account,
      kind: chat.kind,
      chat: chat.id,
      ...(replyThread ? { thread: replyThread } : {}),
    });
    const queued = await deps.app.turn({
      surface: SURFACE,
      actor: author,
      surfaceOrigin: {
        author: { surface: SURFACE, account: event.account, id: message.user.id },
        workspace: event.account,
        ...(replyThread ? { replyThread } : {}),
        audience: "internal",
      },
      conversation: {
        kind: chat.kind,
        threadRef: replyTarget,
        ...(chat.kind === "group" ? { channelRef: container, isPrivate: true } : {}),
        ...(chat.name ? { channelName: chat.name } : {}),
        audience: humans,
      },
      deliveryTarget: replyTarget,
      text: message.body,
      origin: { kind: "human", messageTs: ts },
      async: true,
      redeliveryKey: `${SURFACE}:${event.account}:${chat.id}:${message.id}`,
    });
    if (queued.runId && !queued.steered)
      deps.followReply?.(queued.runId, {
        type: SURFACE,
        target: replyTarget,
        account: { id: event.account, workspace: event.account },
      });
    return { status: 200, body: { ok: true } };
  }

  async function answerContext(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    const ref = query.conversationTarget ? parsePartnerChatRef(query.conversationTarget) : null;
    if (!ref) return { messages: [], note: "this conversation can't be read" };
    const container = partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat });
    const scan = await cache.readMessages(container, {
      surface: SURFACE,
      ...(ref.thread ? { sub: ref.thread } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: CONTEXT_SCAN,
      noFallback: true,
    });
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
        scanHasMore: scan.length === CONTEXT_SCAN,
      },
    );
  }

  deps.app.onContextRequestCreated((request) => {
    if (request.source !== SURFACE) return;
    void answerContext(request.query)
      .then((result) => deps.app.fulfillContextRequest(request.id, { result }))
      .catch(reportFailureAs("partner-chat: answer context request", undefined));
  });

  return { handle };
}
