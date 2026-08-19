export const SECURITY_QUARANTINE_REFUSAL_TEXT =
  "I couldn't act because my security screen flagged part of this message or its conversation context. Please retry without the flagged context, or ask an admin to review the quarantine.";

/**
 * The refusal text promises an admin review of the quarantine. The refused
 * input and the screen's full request snapshot are stored on the session
 * (readable via GET /v1/admin/sessions/:id/llm), so when the refusal carries a
 * session id, surface it: that is the record an admin reviews (#574).
 */
export function quarantineRefusalText(sessionId?: string): string {
  return sessionId
    ? `${SECURITY_QUARANTINE_REFUSAL_TEXT} (quarantine record: session ${sessionId})`
    : SECURITY_QUARANTINE_REFUSAL_TEXT;
}
