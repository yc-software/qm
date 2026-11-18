import type { SessionStateBus, SessionStateEvent } from "../runs/session-state-bus.ts";
import { isWebThread, type SessionStore } from "../sessions/session-store.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { reportFailure } from "../util/errors.ts";

export interface ReplyNotice {
  sessionId: string;
  title: string;
  body: string;
  url?: string;
}

export type ReplyNoticeSender = (principalId: string, notice: ReplyNotice) => Promise<void>;

const PUSH_RECORD_BYTES = 4096;
const AES128GCM_OVERHEAD_BYTES = 103;
const REPLY_NOTICE_MAX_BYTES = PUSH_RECORD_BYTES - AES128GCM_OVERHEAD_BYTES;
const UNTITLED = "New reply";
const NOTIFYING_STATES = new Set<SessionStateEvent["state"]>(["idle", "awaiting_approval"]);

const noticeBytes = (notice: ReplyNotice): number => Buffer.byteLength(JSON.stringify(notice), "utf8");

export function fitReplyNotice(notice: ReplyNotice, maxBytes = REPLY_NOTICE_MAX_BYTES): ReplyNotice {
  if (noticeBytes(notice) <= maxBytes) return notice;
  let room = maxBytes - noticeBytes({ ...notice, body: "…" });
  let body = "";
  for (const char of notice.body) {
    room -= Buffer.byteLength(JSON.stringify(char), "utf8") - 2;
    if (room < 0) break;
    body += char;
  }
  return { ...notice, body: `${body}…` };
}

export function watchReplyNotices(deps: {
  bus: SessionStateBus;
  sessions: Pick<SessionStore, "claimReplyNotifications">;
  publicUrl?: string;
  senders: readonly ReplyNoticeSender[];
}): () => void {
  const notify = async (event: SessionStateEvent): Promise<void> => {
    if (!NOTIFYING_STATES.has(event.state) || !event.sessionId || !isWebThread(event.threadRef)) return;
    const sessionId = event.sessionId;
    const url = conversationWebUrl(deps.publicUrl, sessionId);
    for (const claim of await deps.sessions.claimReplyNotifications(sessionId)) {
      const notice = fitReplyNotice({
        sessionId,
        title: claim.title?.trim() || UNTITLED,
        body: claim.text.trim(),
        ...(url ? { url } : {}),
      });
      deps.bus.emit({
        threadRef: event.threadRef,
        sessionId,
        participants: [claim.principalId],
        state: "notify",
        notice,
        at: Date.now(),
      });
      await Promise.all(
        deps.senders.map((send) =>
          send(claim.principalId, notice).catch((error: unknown) =>
            reportFailure("notifications: send reply notice", error, `session=${sessionId}`),
          ),
        ),
      );
    }
  };
  return deps.bus.subscribe((event) =>
    notify(event).catch((error: unknown) =>
      reportFailure("notifications: claim reply notices", error, `session=${event.sessionId ?? event.threadRef}`),
    ),
  );
}
