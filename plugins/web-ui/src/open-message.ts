import { fetchTranscript, TAIL_TURNS, type CoreSession, type PendingApproval, type TranscriptPage } from "./core-bridge";
import { allConversations } from "./conversations";
import { loadMessageTranscript } from "./message-link.ts";
import { openSession, revealSessionSurface, sessionsState } from "./sessions";

/** Switch to `linked` (adding it to the sidebar list if absent) and, given a seq, scroll to and highlight that entry. */
export async function showLinkedSession(
  linked: CoreSession,
  transcript?: Promise<TranscriptPage | null>,
  seq: number | null = null,
  approvals?: Promise<{ approvals: PendingApproval[] } | null>,
): Promise<void> {
  if (!sessionsState.list.some((s) => s.id === linked.id)) sessionsState.list = [linked, ...sessionsState.list];
  revealSessionSurface(linked);
  await openSession(linked, transcript, approvals, "replace");
  if (seq !== null)
    requestAnimationFrame(() => {
      for (const conversation of allConversations())
        if (conversation.state.sessionId === linked.id) conversation.revealEntry(seq);
    });
}

/**
 * Open a session at one of its messages: reveal it in place when the session is already on screen, otherwise load
 * a transcript window reaching back to `seq` before switching. Resolves false when the session couldn't be found.
 */
export async function openSessionAtMessage(
  sessionId: string,
  seq: number | null,
  findSession?: () => Promise<CoreSession | null>,
): Promise<boolean> {
  const open = allConversations().find(
    (conversation) => conversation.state.sessionId === sessionId && conversation.state.host?.isConnected,
  );
  if (open) {
    if (seq !== null) open.revealEntry(seq);
    return true;
  }
  const transcript = loadMessageTranscript((window) => fetchTranscript(sessionId, window), seq, TAIL_TURNS).catch(
    () => null,
  );
  const linked =
    sessionsState.list.find((s) => s.id === sessionId) ??
    (await findSession?.()) ??
    (await transcript)?.session ??
    null;
  if (!linked) return false;
  await showLinkedSession(linked, transcript, seq);
  return true;
}
