const SECURITY_QUARANTINE_REFUSAL_INTRO =
  "I couldn't act because my security screen flagged part of this message or its conversation context.";

export const SECURITY_QUARANTINE_REFUSAL_TEXT = `${SECURITY_QUARANTINE_REFUSAL_INTRO} Please retry without the flagged context.`;

export function quarantineRefusalText(adminUrl?: string): string {
  if (!adminUrl || /[\u0000-\u001f\u007f]/.test(adminUrl)) return SECURITY_QUARANTINE_REFUSAL_TEXT;
  const reviewUrl = adminUrl.trim();
  if (!reviewUrl || /[\s<>"']/.test(reviewUrl) || !/^https?:\/\//i.test(reviewUrl))
    return SECURITY_QUARANTINE_REFUSAL_TEXT;
  try {
    const url = new URL(reviewUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname)
      return SECURITY_QUARANTINE_REFUSAL_TEXT;
    return `${SECURITY_QUARANTINE_REFUSAL_INTRO} Please retry without the flagged context, or ask an admin to review this quarantine in session history: ${url.href}`;
  } catch {
    return SECURITY_QUARANTINE_REFUSAL_TEXT;
  }
}
