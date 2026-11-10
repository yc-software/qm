import type { DurableMap } from "../persistence/durable-map.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { PendingApprovalRecord } from "../types.ts";

export const BOT_REQUESTER_APPROVAL_NOTE =
  "This request came from a bot or app, not a person. Only the person who asked can approve a step that needs approval, so no approval was requested and the step did not run. Continue without it, and tell the thread that a person has to ask for this step themselves.";

export const BOT_REQUESTER_REFUSAL =
  "This request came from a bot or app, and the next step needs a person's approval. A person has to ask for it directly.";

export const undeliverableApprovalNote = (failure: string): string =>
  `The approval request for this step could not be delivered to the person who asked (${failure}), so it was declined and the step did not run. Continue without it, and tell the thread that a person has to ask for this step themselves.`;

export const UNREACHABLE_APPROVAL_DECIDER = "system:approval-unreachable";

export function requesterIsBot(
  request: { botActor?: boolean; actor?: { isBot?: boolean } | undefined } | undefined,
): boolean {
  return request?.botActor === true || request?.actor?.isBot === true;
}

export async function declineUnreachableApproval(
  deps: { approvals: DurableMap<PendingApprovalRecord>; sessions: Pick<SessionStore, "append"> },
  requestId: string,
  failure: string,
): Promise<PendingApprovalRecord | null> {
  const record = await deps.approvals.take(requestId);
  if (!record) return null;
  const writer = { sessionId: record.sessionId };
  await deps.sessions.append(writer, {
    kind: "ElicitationResponse",
    elicitId: requestId,
    approved: false,
    author: UNREACHABLE_APPROVAL_DECIDER,
    body: { command: record.command, declined: "requester_unreachable", failure },
  });
  if (record.kind !== "input" && !record.screenedOutput)
    await deps.sessions.append(writer, {
      kind: "UserMessage",
      hidden: true,
      text: `${undeliverableApprovalNote(failure)}\nThe step: ${record.summary ?? record.command}`,
    });
  return record;
}
