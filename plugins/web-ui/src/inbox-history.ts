import type { InboxItem, LedgerThreadMessage } from "./inbox.ts";

function excerpt(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
}

export function inboxConversationTitle(messages: readonly LedgerThreadMessage[]): string {
  const first =
    messages.find((message) => message.role === "human" && message.text.trim()) ??
    messages.find((message) => message.text.trim());
  return first ? excerpt(first.text, 100) : "";
}

export function previousInboxConversations(item: Pick<InboxItem, "thread" | "conversationId">) {
  const groups = new Map<string, LedgerThreadMessage[]>();
  for (const message of item.thread) {
    const id = message.conversationId ?? "";
    if (id === (item.conversationId ?? "")) continue;
    const messages = groups.get(id) ?? [];
    messages.push(message);
    groups.set(id, messages);
  }
  return [...groups]
    .map(([id, messages]) => {
      messages.sort((a, b) => a.at - b.at);
      const first =
        messages.find((message) => message.role === "human" && message.text.trim()) ??
        messages.find((message) => message.text.trim());
      const lastReply = messages.findLast((message) => message.role === "agent" && message.text.trim());
      return {
        id,
        title: inboxConversationTitle(messages) || "Previous conversation",
        preview: lastReply && lastReply !== first ? excerpt(lastReply.text, 180) : "",
        at: messages.at(-1)!.at,
        messages,
      };
    })
    .sort((a, b) => b.at - a.at);
}

export function previousInboxAssistantSessions(
  sessions: readonly import("./core-bridge").CoreSession[],
  user: string,
  currentThread: string | null,
): import("./core-bridge").CoreSession[] {
  const prefix = `web:${user}:inbox:`;
  return sessions
    .filter((session) => session.id && session.threadRef.startsWith(prefix) && session.threadRef !== currentThread)
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
}

export function inboxHistoryDate(at: number, now = Date.now()): string {
  const day = (ms: number) => {
    const date = new Date(ms);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  };
  const days = Math.max(0, day(now) - day(at));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "A week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "A month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "A year ago" : `${years} years ago`;
}
