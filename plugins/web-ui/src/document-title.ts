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

export const PRODUCT_TITLE = "QM · Web";

const VIEW_TITLES: Record<View, string> = {
  chats: "Chats",
  contexts: "Projects",
  webhooks: "Webhooks",
  crons: "Crons",
  files: "Files",
  keychain: "Keychain",
  deploys: "Apps",
  memory: "Memory",
  skills: "Skills",
};

export function documentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): string {
  const title =
    view === "chats" && conversationOpen ? conversationTitle?.trim() || "New chat" : view && VIEW_TITLES[view];
  return title ? `${title} · ${PRODUCT_TITLE}` : PRODUCT_TITLE;
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
