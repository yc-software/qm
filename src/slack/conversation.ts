import { resolveMentions } from "./mrkdwn.ts";
export { resolveMentions } from "./mrkdwn.ts";
import { encodeTs, summarizeReactions, type ReactionTally } from "./reactions.ts";
import {
  buildContextWindow as buildSurfaceContextWindow,
  clipText,
  compareTs as compareSlackTimestamps,
  epochTsTime,
} from "../surfaces/context-window.ts";

export function buildContextWindow(
  scanned: readonly RecentMessage[],
  opts: { count: number; match?: string; scanHasMore?: boolean; nameById?: ReadonlyMap<string, string> },
): ReturnType<typeof buildSurfaceContextWindow> {
  const { nameById, ...rest } = opts;
  return buildSurfaceContextWindow(scanned, {
    ...rest,
    renderText: (text) => resolveMentions(text, nameById),
    clipChars: MAX_CONTEXT_MESSAGE_CHARS,
  });
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

const MAX_CONTEXT_MESSAGE_CHARS = 600;
export const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_MESSAGE_CHARS = 300;
const MAX_TURN_MESSAGE_CHARS = 4000;

export function recentWindow(
  candidates: readonly RecentMessage[],
  limit: number = MAX_RECENT_MESSAGES,
): RecentMessage[] {
  const usable = candidates.filter((m) => m.ts && (m.name || m.text?.trim() || m.files?.length));
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

export interface ConversationView {
  contextNote?: string;
  channel: { kind: "dm" | "channel" | "group"; isPrivate?: boolean };
  messages: readonly RecentMessage[];
  here: { kind: "thread"; youOpenedIt: boolean; openerText?: string } | { kind: "top-level" };
  nameById?: ReadonlyMap<string, string>;
}

export interface ConversationTurn {
  role: "user" | "bot" | "assistant";
  name?: string;
  text: string;
}

export interface OverheardMessage {
  ts: string;
  role: "user" | "bot" | "self";
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

const clipMessage = (t: string, max: number = MAX_RECENT_MESSAGE_CHARS): string => clipText(t, max);

export const formatSlackTs = epochTsTime;

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
    return { role: m.isBot ? "bot" : "user", name: m.name || "someone", text };
  });
  const priorTurns = mergeConsecutiveTurns(rawTurns);

  const overheard: OverheardMessage[] = display
    .map(({ message: m }) => {
      const text = clipMessage(resolveMentions(m.text ?? "", view.nameById), MAX_TURN_MESSAGE_CHARS);
      if (!text && !m.files?.length) return undefined;
      let role: OverheardMessage["role"] = m.isBot ? "bot" : "user";
      if (m.isSelf) role = "self";
      return {
        ts: m.ts,
        role,
        ...(m.isSelf ? {} : { name: m.name || "someone" }),
        text,
        ...(m.files?.length ? { files: m.files } : {}),
      };
    })
    .filter((m): m is OverheardMessage => m !== undefined);

  let where = `You are in a channel${view.channel.isPrivate ? " (private)" : ""}.`;
  if (view.channel.kind === "dm") where = "This is a direct message.";
  else if (view.channel.kind === "group") where = "This is a group direct message.";
  let here: string;
  if (view.here.kind === "top-level") here = "You are replying to a top-level message (not in a thread).";
  else if (view.here.youOpenedIt) here = "You are replying in a thread you started.";
  else here = "You are replying in a thread.";

  const header = [where, here, view.contextNote].filter(Boolean).join(" ");

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
  const inlineName = (t: ConversationTurn): string =>
    t.role !== "assistant" && t.name ? `${t.name}: ${t.text}` : t.text;
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== t.role) {
      out.push(
        t.role !== "assistant" && t.name
          ? { role: t.role, name: t.name, text: t.text }
          : { role: t.role, text: t.text },
      );
      continue;
    }
    if (prev.role !== "assistant" && prev.name !== undefined) {
      prev.text = inlineName(prev);
      delete prev.name;
    }
    prev.text = `${prev.text}\n${inlineName(t)}`;
  }
  return out;
}
