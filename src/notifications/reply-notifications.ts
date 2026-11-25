import type { SessionStateBus, SessionStateEvent } from "../runs/session-state-bus.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { scopeId } from "../types.ts";
import { reportFailure } from "../util/errors.ts";

export interface ReplyNotice {
  sessionId: string;
  title: string;
  body: string;
}

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

export async function webNotificationsOn(
  deps: { featureFlags?: Pick<FeatureFlagStore, "enabled"> },
  person: string,
): Promise<boolean> {
  return (await deps.featureFlags?.enabled("web_notifications", scopeId("personal", person))) === true;
}

export function watchReplyNotices(deps: {
  bus: SessionStateBus;
  sessions: Pick<SessionStore, "claimReplyNotifications">;
  notifiable: () => Promise<readonly string[] | "everyone">;
}): () => void {
  const notify = async (event: SessionStateEvent): Promise<void> => {
    if (!NOTIFYING_STATES.has(event.state) || !event.sessionId) return;
    const people = await deps.notifiable();
    if (people !== "everyone" && !people.length) return;
    const sessionId = event.sessionId;
    const claims = await deps.sessions.claimReplyNotifications(sessionId, people);
    if (!claims.length) return;
    for (const claim of claims)
      deps.bus.emit({
        threadRef: event.threadRef,
        sessionId,
        participants: [claim.principalId],
        state: "notify",
        notice: fitReplyNotice({ sessionId, title: claim.title?.trim() || UNTITLED, body: claim.text.trim() }),
        at: Date.now(),
      });
  };
  return deps.bus.subscribe((event) =>
    notify(event).catch((error: unknown) =>
      reportFailure("notifications: claim reply notices", error, `session=${event.sessionId ?? event.threadRef}`),
    ),
  );
}
