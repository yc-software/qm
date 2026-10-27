import { randomUUID } from "node:crypto";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { SessionMailbox } from "../sessions/session-mailbox.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { Session } from "../types.ts";
import { mapBounded } from "../util/async.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import type { SwarmBoard, SwarmBoardPost } from "./swarm-board.ts";

export const SWARM_ACTIONS = [
  "start",
  "channels",
  "create_channel",
  "threads",
  "search",
  "read_thread",
  "read_post",
  "post",
  "subscribe",
  "unsubscribe",
] as const;

type SwarmAction = (typeof SWARM_ACTIONS)[number];

export interface SwarmMemberOpen {
  requestId: string;
  task: string;
  name?: string;
  readOnly?: boolean;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
}

export interface SwarmInput {
  action: SwarmAction;
  requestId: string;
  members?: Array<{ task: string; name?: string }>;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  noComputer?: boolean;
  channel?: string;
  description?: string;
  query?: string;
  postId?: string;
  replyTo?: string;
  text?: string;
  before?: number;
  after?: number;
  limit?: number;
}

export type SwarmResult = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };

export interface SwarmCallContext {
  board: SwarmBoard;
  sessions: Pick<SessionStore, "get">;
  mailbox: SessionMailbox;
  session: Session;
  actor: OrchestratorInput["actor"];
  audience: OrchestratorInput["conversation"]["audience"];
  open(
    input: SwarmMemberOpen,
  ): Promise<{ ok: true; sessionId: string; title: string } | { ok: false; message: string }>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PREVIEW_CHARS = 500;
const NOTICE_CHARS = 2_000;
const THREAD_CHARS = 64_000;
const NOTIFY_GRACE_MS = 60_000;
const OPEN_CONCURRENCY = 4;
const NOTIFY_CONCURRENCY = 8;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function memberNote(swarmId: string, coordinator: string): string {
  return `You are a member of the swarm "${coordinator}" (swarm ID ${swarmId}). It has a shared board you reach with the swarm tool: read channels, threads and posts, search, post or reply, and subscribe to a channel to be told about new posts. Board use is voluntary. Your final answer still returns to the coordinator as with any subagent.`;
}

interface PostView {
  id: string;
  channel: string;
  replyTo?: string;
  author: string;
  authorSessionId: string;
  createdAt: string;
  cursor: number;
  text: string;
  replies?: number;
  truncated?: true;
}

function preview(post: SwarmBoardPost): PostView {
  const full = view(post);
  return post.body.length > PREVIEW_CHARS
    ? { ...full, text: `${post.body.slice(0, PREVIEW_CHARS)}…`, truncated: true }
    : full;
}

function view(post: SwarmBoardPost): PostView {
  return {
    id: post.id,
    channel: post.channel,
    ...(post.threadId ? { replyTo: post.threadId } : {}),
    author: post.authorName,
    authorSessionId: post.authorId,
    createdAt: new Date(post.createdAt).toISOString(),
    cursor: post.createdAt,
    text: post.body,
  };
}

function renderNotice(swarmId: string, post: SwarmBoardPost): string {
  const body =
    post.body.length > NOTICE_CHARS ? `${post.body.slice(0, NOTICE_CHARS)}… [read_post for the rest]` : post.body;
  return [
    `<swarm-board-post swarm="${swarmId}" channel="${xmlAttrEscape(post.channel)}" postId="${post.id}"${
      post.threadId ? ` replyTo="${post.threadId}"` : ""
    } from="${xmlAttrEscape(post.authorName)}" fromSessionId="${post.authorId}">`,
    xmlEscape(body),
    "</swarm-board-post>",
  ].join("\n");
}

async function chain(sessions: SwarmCallContext["sessions"], session: Session): Promise<string[]> {
  const ids = [session.id];
  let current = session;
  while (current.parentSessionId && !ids.includes(current.parentSessionId)) {
    const parent = await sessions.get(current.parentSessionId);
    if (!parent) break;
    ids.push(parent.id);
    current = parent;
  }
  return ids;
}

async function notifySubscribers(ctx: SwarmCallContext, post: SwarmBoardPost): Promise<number> {
  const notice = renderNotice(post.swarmId, post);
  const notified = (await ctx.board.subscribers(post.swarmId, post.channel)).filter((id) => id !== post.authorId);
  await mapBounded(notified, NOTIFY_CONCURRENCY, (recipientId) =>
    ctx.mailbox.send({
      id: `swarm-post-${post.id}-${recipientId}`,
      recipientId,
      senderId: post.authorId,
      actor: ctx.actor,
      text: notice,
      audience: ctx.audience,
      createdAt: post.createdAt,
    }),
  );
  await ctx.board.markNotified(post.swarmId, post.id);
  return notified.length;
}

const clampLimit = (limit: number | undefined) => Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));

export async function swarmCall(ctx: SwarmCallContext, input: SwarmInput): Promise<SwarmResult> {
  const title = ctx.session.title?.trim() || ctx.session.id;
  const swarmId = await ctx.board.firstBoard(await chain(ctx.sessions, ctx.session));
  if (input.action === "start") {
    if (swarmId && swarmId !== ctx.session.id)
      return {
        ok: false,
        message: `you are a member of swarm ${swarmId}; only its coordinator adds members. Coordinate on its board instead.`,
      };
    const members = (input.members ?? []).filter((member) => member.task?.trim());
    if (!members.length) return { ok: false, message: "start requires `members`: one {task, name?} per subagent." };
    await ctx.board.ensure(ctx.session.id, ctx.session.id, Date.now());
    const opened = await mapBounded(members, OPEN_CONCURRENCY, async (member, index) => {
      const result = await ctx.open({
        requestId: `${input.requestId}:${index}`,
        task: `${member.task.trim()}\n\n${memberNote(ctx.session.id, title)}`,
        ...(member.name?.trim() ? { name: member.name.trim() } : {}),
        ...(input.noComputer !== undefined ? { readOnly: input.noComputer } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
      });
      return result.ok
        ? { sessionId: result.sessionId, title: result.title }
        : { error: result.message, task: member.name?.trim() || member.task.trim().slice(0, 60) };
    });
    return { ok: true, result: { swarmId: ctx.session.id, members: opened } };
  }
  if (!swarmId)
    return {
      ok: false,
      message: "this session is not in a swarm. A coordinator creates one with swarm start; its members inherit it.",
    };
  const stranded = await ctx.board
    .unnotified(swarmId, Date.now() - NOTIFY_GRACE_MS)
    .catch(swallowAs("swarm board: list stranded notices", []));
  await mapBounded(stranded, NOTIFY_CONCURRENCY, (post) =>
    notifySubscribers(ctx, post).catch(swallowAs("swarm board: redeliver a stranded notice", 0)),
  );
  const channel = input.channel?.trim().toLowerCase();
  switch (input.action) {
    case "channels":
      return { ok: true, result: { swarmId, channels: await ctx.board.channels(swarmId) } };
    case "create_channel": {
      if (!channel || !CHANNEL_NAME.test(channel))
        return {
          ok: false,
          message: "create_channel requires `channel`: lowercase letters, digits, - or _, up to 40.",
        };
      const created = await ctx.board.createChannel(
        swarmId,
        channel,
        input.description?.trim() ?? "",
        ctx.session.id,
        Date.now(),
      );
      return { ok: true, result: { swarmId, channel, created } };
    }
    case "threads":
    case "search": {
      const limit = clampLimit(input.limit);
      const page = { ...(channel ? { channel } : {}), ...(input.before ? { before: input.before } : {}), limit };
      if (input.action === "search" && !input.query?.trim()) return { ok: false, message: "search requires `query`." };
      const posts =
        input.action === "threads"
          ? (await ctx.board.threads(swarmId, page)).map((post) => ({ ...preview(post), replies: post.replies }))
          : (await ctx.board.search(swarmId, input.query!.trim(), page)).map(preview);
      return {
        ok: true,
        result: {
          swarmId,
          posts,
          ...(posts.length === limit ? { nextBefore: posts.at(-1)!.cursor } : {}),
        },
      };
    }
    case "read_thread": {
      if (!input.postId) return { ok: false, message: "read_thread requires `postId` (the thread's first post)." };
      const root = await ctx.board.post(swarmId, input.postId);
      if (!root) return { ok: false, message: `no post ${input.postId} on this board.` };
      const limit = clampLimit(input.limit);
      const fetched = await ctx.board.thread(swarmId, root.threadId ?? root.id, input.after, limit);
      let budget = THREAD_CHARS;
      const posts = fetched.filter((post, index) => (budget -= post.body.length) >= 0 || index === 0).map(view);
      return {
        ok: true,
        result: {
          swarmId,
          threadId: root.threadId ?? root.id,
          posts,
          ...(posts.length < fetched.length || posts.length === limit ? { nextAfter: posts.at(-1)!.cursor } : {}),
        },
      };
    }
    case "read_post": {
      if (!input.postId) return { ok: false, message: "read_post requires `postId`." };
      const post = await ctx.board.post(swarmId, input.postId);
      return post
        ? { ok: true, result: { swarmId, post: view(post) } }
        : { ok: false, message: `no post ${input.postId} on this board.` };
    }
    case "post": {
      const body = input.text?.trim();
      if (!body) return { ok: false, message: "post requires `text`." };
      const parent = input.replyTo ? await ctx.board.post(swarmId, input.replyTo) : null;
      if (input.replyTo && !parent) return { ok: false, message: `no post ${input.replyTo} on this board.` };
      const target = parent?.channel ?? channel ?? "general";
      if (!parent && !(await ctx.board.hasChannel(swarmId, target)))
        return { ok: false, message: `no channel "${target}"; create_channel first or post to general.` };
      const post: SwarmBoardPost = {
        id: randomUUID(),
        swarmId,
        channel: target,
        threadId: parent ? (parent.threadId ?? parent.id) : null,
        authorId: ctx.session.id,
        authorName: title,
        body,
        createdAt: Date.now(),
      };
      await ctx.board.insert(post);
      const notified = await notifySubscribers(ctx, post).catch((e: unknown) => errMessage(e));
      return {
        ok: true,
        result: {
          swarmId,
          post: view(post),
          ...(typeof notified === "number"
            ? { notified }
            : { notified: 0, notifyError: `${notified} — subscribers are told on the next board action` }),
        },
      };
    }
    case "subscribe":
    case "unsubscribe": {
      const target = channel ?? "general";
      if (!(await ctx.board.hasChannel(swarmId, target))) return { ok: false, message: `no channel "${target}".` };
      if (input.action === "subscribe") await ctx.board.subscribe(swarmId, ctx.session.id, target);
      else await ctx.board.unsubscribe(swarmId, ctx.session.id, target);
      return { ok: true, result: { swarmId, channel: target, subscribed: input.action === "subscribe" } };
    }
  }
}
