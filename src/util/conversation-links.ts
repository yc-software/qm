export function conversationWebUrl(publicWebUrl: string | undefined, sessionId: string): string | undefined {
  const raw = publicWebUrl?.trim();
  if (!raw || !/^https?:\/\//i.test(raw) || /[?#]/.test(raw)) return undefined;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) return undefined;
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/s/${encodeURIComponent(sessionId)}`;
    return base.toString();
  } catch {
    return undefined;
  }
}
