import { swallowAs } from "../../chassis/src/errors";
import {
  fetchTranscript,
  TAIL_TURNS,
  type CoreSession,
  type PendingApproval,
  type TranscriptPage,
} from "./core-bridge";
import { allConversations, mainConversation } from "./conversations";
import { focusedPaneConversation } from "./split";
import { loadMessageTranscript, messageEntrySeqs } from "./message-link.ts";
import { openSession, revealSessionSurface, sessionsState } from "./sessions";

export async function showLinkedSession(
  linked: CoreSession,
  transcript?: Promise<TranscriptPage | null>,
  seq: number | null = null,
  approvals?: Promise<{ approvals: PendingApproval[] } | null>,
  historyMode: "push" | "replace" = "replace",
): Promise<void> {
  if (!sessionsState.list.some((s) => s.id === linked.id)) sessionsState.list = [linked, ...sessionsState.list];
  revealSessionSurface(linked);
  await openSession(linked, transcript, approvals, historyMode);
  if (seq !== null)
    requestAnimationFrame(() => {
      for (const conversation of allConversations())
        if (conversation.state.sessionId === linked.id) conversation.revealEntry(seq);
    });
}

export async function openSessionAtMessage(
  sessionId: string,
  seq: number | null,
  findSession?: () => Promise<CoreSession | null>,
  historyMode: "push" | "replace" = "replace",
): Promise<boolean> {
  const focused = focusedPaneConversation() ?? mainConversation();
  const host = focused.state.host;
  if (focused.state.sessionId === sessionId && host?.isConnected) {
    if (seq === null) return true;
    if (
      host.querySelector(`.message-row[data-entry-seqs~="${seq}"]`) ||
      focused.state.inheritedMessages.some((m) => messageEntrySeqs(m).includes(seq))
    ) {
      focused.revealEntry(seq);
      return true;
    }
  }
  const transcript = loadMessageTranscript((window) => fetchTranscript(sessionId, window), seq, TAIL_TURNS).catch(
    swallowAs("web-ui: open session at message", null),
  );
  const linked =
    sessionsState.list.find((s) => s.id === sessionId) ??
    (await findSession?.()) ??
    (await transcript)?.session ??
    null;
  if (!linked) return false;
  await showLinkedSession(linked, transcript, seq, undefined, historyMode);
  return true;
}
