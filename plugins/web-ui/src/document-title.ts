import type { View } from "./shell-state";

interface TitledSession {
  id: string;
  threadRef: string;
}

interface ActiveConversation {
  openingKey: string | null;
  sessionId: string | null;
  threadRef: string | null;
}

/** Shared with the server's branded <title>, so the tab title has one format (#2108). */
export const TITLE_SUFFIX = "· Web";

/** The org's brand, from the meta tag the server stamps; the client's only source for it. */
export function brandName(): string {
  if (typeof document === "undefined") return "QM";
  return document.querySelector<HTMLMetaElement>('meta[name="brand-self-label"]')?.content || "QM";
}

const VIEW_TITLES: Record<View, string> = {
  chats: "Chats",
  inbox: "Inbox",
  calendar: "Calendar",
  contexts: "Projects",
  crons: "Crons",
  loops: "Loops",
  webhooks: "Webhooks",
  files: "Files",
  keychain: "Keychain",
  deploys: "Apps",
  memory: "Memory",
  skills: "Skills",
  settings: "Settings",
};

export function documentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): string {
  const title =
    view === "chats" && conversationOpen ? conversationTitle?.trim() || "New chat" : view && VIEW_TITLES[view];
  return `${title ? `${title} · ` : ""}${brandName()} ${TITLE_SUFFIX}`;
}

export function updateDocumentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): void {
  document.title = documentTitle(view, conversationTitle, conversationOpen);
}

export function activeSessionForDocumentTitle<T extends TitledSession>(
  sessions: T[],
  active: ActiveConversation,
): T | undefined {
  if (active.openingKey) return sessions.find((session) => session.id === active.openingKey);
  return sessions.find(
    (session) => session.id === active.sessionId || (!active.sessionId && session.threadRef === active.threadRef),
  );
}
