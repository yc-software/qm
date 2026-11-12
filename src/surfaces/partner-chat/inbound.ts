import type { App } from "../../api/app-types.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../../reach/reach.ts";
import type { Destination, TurnResult } from "../../types.ts";
import type { SurfaceCache } from "../../surface-cache/surface-cache.ts";
import { inTenant } from "../../tenants/claim.ts";
import { errMessage, reportFailureAs } from "../../util/errors.ts";
import { buildContextWindow } from "../context-window.ts";
import { partnerChatPrincipal } from "./adapter.ts";
import {
  findMessage,
  partnerChatRef,
  partnerChatTs,
  parsePartnerChatEvent,
  parsePartnerChatRef,
  verifyPartnerChat,
  type PartnerChatEvent,
} from "./protocol.ts";

const SURFACE = "partner-chat";
const CONTEXT_SCAN = 500;
const CONTEXT_DEFAULT_COUNT = 100;

type InboundApp = Pick<
  App,
  "turn" | "ingestSurfaceEvents" | "onContextRequestCreated" | "fulfillContextRequest" | "tenantFor"
>;

export function createPartnerChatInbound(deps: {
  secret: string;
  app: InboundApp;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  isInternalEmail: (email: string) => Promise<boolean>;
  unansweredReply: (result: TurnResult, destination: Destination, idempotencyKey: string) => Promise<void>;
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
    return mine.length > 0 || (await findMessage(cache, container, thread, { self: true })) !== undefined;
  }

  async function threadDetection(container: string, thread: string, triggerTs: string) {
    const [root, replies] = await Promise.all([
      findMessage(cache, container, thread),
      cache.readMessages(container, { surface: SURFACE, sub: thread, limit: CONTEXT_DEFAULT_COUNT, noFallback: true }),
    ]);
    const detectContext = replies
      .filter((m) => !m.self && !m.bot && m.ts !== triggerTs)
      .map((m) => `${m.authorName ?? m.authorId ?? "someone"}: ${m.text}`)
      .join("\n");
    return {
      ...(detectContext ? { detectContext } : {}),
      ...(root?.self && root.text ? { detectOpener: root.text } : {}),
    };
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
    return inTenant(tenant, () => accept(event));
  }

  async function accept(event: PartnerChatEvent) {
    const { message, chat } = event;
    const members = chat.members.filter((m) => !m.bot);
    if (chat.kind === "dm" && (members.length !== 1 || members[0]!.id !== message.user.id)) {
      console.log(
        `[partner-chat] ignoring dm ${chat.id}: it lists ${members.length} non-bot member(s), and a dm must list only its author`,
      );
      return { status: 200, body: { ok: true, ignored: "not_one_to_one" } };
    }
    const humans = await Promise.all(
      members.map(async (m) =>
        partnerChatPrincipal(m, await deps.isInternalEmail(m.email?.trim().toLowerCase() ?? "")),
      ),
    );
    const listed = chat.members.find((m) => m.id === message.user.id);
    const guests = humans.filter((p) => p.isExternalGuest).length;
    if (guests || !listed) {
      console.log(
        `[partner-chat] ignoring chat ${chat.id}: ${guests} member(s) not vouched for as internal, author listed: ${Boolean(listed)}`,
      );
      return { status: 200, body: { ok: true, ignored: "unvouched_participants" } };
    }
    const bot = listed.bot === true;
    const author = bot ? partnerChatPrincipal(listed, false) : humans[members.indexOf(listed)]!;
    const thread = event.thread_id ?? undefined;
    const container = partnerChatRef({ account: event.account, kind: chat.kind, chat: chat.id });
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
    const following = startsTurn && !direct && thread !== undefined && (await threadEngaged(container, thread));
    const addressed = startsTurn && (direct || following);
    await deps.app.ingestSurfaceEvents(
      [
        {
          surface: SURFACE,
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
      ...(chat.kind === "group" && replyTarget !== container
        ? {
            deliveryCandidates: [
              { target: replyTarget, label: "this thread" },
              { target: container, label: chat.name ? `${chat.name} (the whole chat)` : "the whole chat" },
            ],
          }
        : {}),
      text: message.body,
      ...(following && thread
        ? {
            origin: { kind: "ambient" as const, entryTs: ts, live: true },
            ...(await threadDetection(container, thread, ts)),
          }
        : { origin: { kind: "human" as const, messageTs: ts } }),
      async: true,
      redeliveryKey: `${SURFACE}:${event.account}:${chat.id}:${message.id}`,
    });
    const destination = {
      type: SURFACE,
      target: replyTarget,
      account: { id: event.account, workspace: event.account },
    };
    if (!queued.runId)
      await deps.unansweredReply(queued, destination, `notice:${SURFACE}:${event.account}:${chat.id}:${message.id}`);
    return { status: 200, body: { ok: true } };
  }

  async function answerContext(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    const ref = query.conversationTarget ? parsePartnerChatRef(query.conversationTarget) : null;
    if (!ref) return { messages: [], note: "this conversation can't be read" };
    const container = partnerChatRef({ account: ref.account, kind: ref.kind, chat: ref.chat });
    const replies = await cache.readMessages(container, {
      surface: SURFACE,
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
    if (request.source !== SURFACE) return;
    void answerContext(request.query)
      .then((result) => deps.app.fulfillContextRequest(request.id, { result }))
      .catch(reportFailureAs("partner-chat: answer context request", undefined));
  });

  return { handle };
}
