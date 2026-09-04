import { encodeTs, summarizeReactions, type ReactionTally } from "./reactions.ts";
import { MAX_ATTACHMENTS_PER_TURN } from "./attachments.ts";

export interface ContextWireMessage {
  ts: string;
  time?: string;
  author: string;
  text: string;
  threadTs?: string;
  files?: string[];
}

const MAX_CONTEXT_MESSAGE_CHARS = 600;

function compareSlackTimestamps(a: { ts: string }, b: { ts: string }): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return 0;
}

export function buildContextWindow(
  scanned: readonly RecentMessage[],
  opts: { count: number; match?: string; scanHasMore?: boolean; nameById?: ReadonlyMap<string, string> },
): { messages: ContextWireMessage[]; hasMore: boolean; nextBefore?: string } {
  const asc = [...scanned].sort(compareSlackTimestamps);
  const needle = opts.match?.trim().toLowerCase();
  const matched = needle ? asc.filter((m) => (m.text ?? "").toLowerCase().includes(needle)) : asc;
  const count = Math.max(1, Math.floor(opts.count));
  const kept = matched.slice(-count);
  const messages = kept.map((m) => {
    const time = formatSlackTs(m.ts);
    return {
      ts: m.ts,
      ...(time ? { time } : {}),
      author: m.isSelf ? "you" : m.name || "someone",
      text: clipMessage(resolveMentions(m.text ?? "", opts.nameById), MAX_CONTEXT_MESSAGE_CHARS),
      ...(m.parentTs ? { threadTs: m.parentTs } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
    };
  });
  const droppedMatches = matched.length > kept.length;
  let nextBefore = opts.scanHasMore ? asc[0]?.ts : undefined;
  if (droppedMatches) nextBefore = kept[0]?.ts;
  return {
    messages,
    hasMore: Boolean(opts.scanHasMore) || droppedMatches,
    ...(nextBefore ? { nextBefore } : {}),
  };
}

export interface RecentMessage {
  ts: string;
  name: string;
  text: string;
  authorId?: string;
  isTrigger?: boolean;
  isBot?: boolean;
  isSelf?: boolean;
  parentTs?: string;
  reactions?: ReactionTally[];
  files?: string[];
}

export const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_MESSAGE_CHARS = 300;
const MAX_TURN_MESSAGE_CHARS = 4000;
export const MAX_TOP_LEVEL_CONTEXT_AGE_S = 24 * 60 * 60;

export function recentWindow(
  candidates: readonly RecentMessage[],
  limit: number = MAX_RECENT_MESSAGES,
  opts?: { triggerTs?: string; maxAgeSeconds?: number },
): RecentMessage[] {
  const cutoff =
    opts?.triggerTs && opts.maxAgeSeconds && Number.isFinite(Number(opts.triggerTs))
      ? Number(opts.triggerTs) - opts.maxAgeSeconds
      : undefined;
  const usable = candidates.filter(
    (m) =>
      m.ts &&
      (m.name || m.text?.trim() || m.files?.length) &&
      (cutoff === undefined || m.isTrigger || Number(m.ts) >= cutoff),
  );
  if (!usable.length) return [];
  const window = Math.max(1, Math.floor(limit));
  const sorted = [...usable].sort(compareSlackTimestamps);
  const byTs = new Map(sorted.map((m) => [m.ts, m] as const));
  const chosen = new Map<string, RecentMessage>(sorted.slice(-window).map((m) => [m.ts, m] as const));
  for (const m of Array.from(chosen.values())) {
    if (m.parentTs && !chosen.has(m.parentTs) && byTs.has(m.parentTs)) chosen.set(m.parentTs, byTs.get(m.parentTs)!);
  }
  return [...chosen.values()].sort(compareSlackTimestamps);
}

function arrangeForDisplay(messages: readonly RecentMessage[]): Array<{ message: RecentMessage; isReply: boolean }> {
  const present = new Set(messages.map((m) => m.ts));
  const childrenByParent = new Map<string, RecentMessage[]>();
  const roots: RecentMessage[] = [];
  for (const m of messages) {
    if (m.parentTs && present.has(m.parentTs)) {
      const siblings = childrenByParent.get(m.parentTs);
      if (siblings) siblings.push(m);
      else childrenByParent.set(m.parentTs, [m]);
    } else {
      roots.push(m);
    }
  }
  const out: Array<{ message: RecentMessage; isReply: boolean }> = [];
  for (const root of roots.sort(compareSlackTimestamps)) {
    out.push({ message: root, isReply: false });
    for (const child of (childrenByParent.get(root.ts) ?? []).sort(compareSlackTimestamps)) {
      out.push({ message: child, isReply: true });
    }
  }
  return out;
}

const SLACK_MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

export function resolveMentions(text: string, nameById: ReadonlyMap<string, string> | undefined): string {
  if (!nameById || !text.includes("<@")) return text;
  return text.replace(SLACK_MENTION, (m, id) => {
    const name = nameById.get(id);
    return name ? `@${name}` : m;
  });
}

interface ConversationMember {
  id: string;
  name: string;
  mentionId?: string;
  isYou?: boolean;
  isBot?: boolean;
}

export interface ConversationView {
  channel: { name?: string; kind: "dm" | "channel" | "group"; isPrivate?: boolean };
  members: readonly ConversationMember[];
  messages: readonly RecentMessage[];
  here: { kind: "thread"; youOpenedIt: boolean; starterName?: string; openerText?: string } | { kind: "top-level" };
  files: ReadonlyArray<{ name: string }>;
  omittedFiles: ReadonlyArray<{ name: string; reason: "too-big" | string }>;
  nameById?: ReadonlyMap<string, string>;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  name?: string;
  text: string;
}

export interface OverheardMessage {
  ts: string;
  role: "user" | "self";
  name?: string;
  text: string;
  files?: string[];
}

export interface RenderedConversation {
  header: string;
  priorTurns: ConversationTurn[];
  overheard: OverheardMessage[];
  allowedTs: Set<string>;
  detectContext: string;
  detectOpener?: string;
}

const clipMessage = (t: string, max: number = MAX_RECENT_MESSAGE_CHARS): string => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function formatSlackTs(ts: string): string {
  const sec = Number(ts);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function messageTurnText(
  m: RecentMessage,
  isReply: boolean,
  nameById: ReadonlyMap<string, string> | undefined,
): string {
  const id = encodeTs(m.ts);
  const idTag = id ? `[${id}] ` : "";
  const replyTag = isReply ? "(reply) " : "";
  const body = clipMessage(resolveMentions(m.text ?? "", nameById), MAX_TURN_MESSAGE_CHARS);
  const fileNote = m.files?.length ? ` (files: ${m.files.join(", ")})` : "";
  const reacted = summarizeReactions(m.reactions);
  const reactNote = reacted ? ` — reactions: ${reacted}` : "";
  return `${idTag}${replyTag}${body}${fileNote}${reactNote}`;
}

export function renderConversationView(view: ConversationView): RenderedConversation {
  const msgs = view.messages.filter((m) => m.ts && (m.name || m.text?.trim() || m.files?.length));
  const allowedTs = new Set<string>(msgs.map((m) => m.ts));

  const display = arrangeForDisplay(msgs).filter(({ message: m }) => !m.isTrigger);
  const rawTurns: ConversationTurn[] = display.map(({ message: m, isReply }) => {
    const text = messageTurnText(m, isReply, view.nameById);
    if (m.isSelf) return { role: "assistant", text };
    return { role: "user", name: m.name || "someone", text };
  });
  const priorTurns = mergeConsecutiveTurns(rawTurns);

  const overheard: OverheardMessage[] = display
    .map(({ message: m }) => {
      const text = clipMessage(resolveMentions(m.text ?? "", view.nameById), MAX_TURN_MESSAGE_CHARS);
      if (!text && !m.files?.length) return undefined;
      return {
        ts: m.ts,
        role: (m.isSelf ? "self" : "user") as "user" | "self",
        ...(m.isSelf ? {} : { name: m.name || "someone" }),
        text,
        ...(m.files?.length ? { files: m.files } : {}),
      };
    })
    .filter((m): m is OverheardMessage => m !== undefined);

  let where = `You are in ${view.channel.name ? `#${view.channel.name}` : "a channel"}${view.channel.isPrivate ? " (private)" : ""}.`;
  if (view.channel.kind === "dm") where = "This is a direct message.";
  else if (view.channel.kind === "group") where = "This is a group direct message.";
  const mentionable = (m: ConversationMember): string => {
    const mentionId = m.mentionId ?? (/^[A-Z0-9]+$/i.test(m.id) ? m.id : undefined);
    const tags = [mentionId ? `<@${mentionId}>` : "", m.isBot ? "agent" : ""].filter(Boolean);
    return `@${m.name}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  };
  const who = view.members.length
    ? "People here: " + view.members.map((m) => (m.isYou ? "you" : mentionable(m))).join(", ") + "."
    : "";
  let here: string;
  if (view.here.kind === "top-level") here = "You are replying to a top-level message (not in a thread).";
  else if (view.here.youOpenedIt) here = "You are replying in a thread you started.";
  else here = `You are replying in a thread${view.here.starterName ? ` @${view.here.starterName} started` : ""}.`;
  const fileNames = view.files.map((f) => f.name).filter((n) => n.trim());
  const shownFileNames = fileNames.slice(0, MAX_ATTACHMENTS_PER_TURN);
  const moreFileNames = fileNames.length - shownFileNames.length;
  const fileLine = shownFileNames.length
    ? "Files referenced in this conversation: " +
      shownFileNames.join(", ") +
      (moreFileNames > 0 ? ` (+${moreFileNames} more).` : ".")
    : "";
  const omittedLine = view.omittedFiles.length
    ? "Files too big to view this turn: " + view.omittedFiles.map((f) => f.name).join(", ") + "."
    : "";

  const header = [fileLine, omittedLine, where, who, here].filter(Boolean).join(" ");

  const detectContext = msgs
    .filter((m) => !m.isBot && !m.isSelf && !m.isTrigger)
    .map((m) => `${m.name || "someone"}: ${clipMessage(resolveMentions(m.text ?? "", view.nameById))}`)
    .join("\n");
  const detectOpener =
    view.here.kind === "thread" && view.here.youOpenedIt
      ? clipMessage(view.here.openerText ?? "") || undefined
      : undefined;

  return { header, priorTurns, overheard, allowedTs, detectContext, ...(detectOpener ? { detectOpener } : {}) };
}

export function mergeConsecutiveTurns(turns: readonly ConversationTurn[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  const inlineName = (t: ConversationTurn): string => (t.role === "user" && t.name ? `${t.name}: ${t.text}` : t.text);
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== t.role) {
      out.push(
        t.role === "user" && t.name ? { role: "user", name: t.name, text: t.text } : { role: t.role, text: t.text },
      );
      continue;
    }
    if (prev.role === "user" && prev.name !== undefined) {
      prev.text = inlineName(prev);
      delete prev.name;
    }
    prev.text = `${prev.text}\n${inlineName(t)}`;
  }
  return out;
}
