export const UI_BASE = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(
  /\/$/,
  "",
);

export function deepLinkPath(
  base: string,
  view: string,
  sessionId: string | null,
  contextScope?: string | null,
  itemId?: string | null,
): string {
  const b = base.replace(/\/$/, "");
  if (view === "contexts" && contextScope) {
    if (itemId) throw new Error("the contexts view is addressed by scope, not by item id");
    return `${b}/contexts?scope=${encodeURIComponent(contextScope)}`;
  }
  if (view !== "chats") return `${b}/${encodeURIComponent(view)}${itemId ? `/${encodeURIComponent(itemId)}` : ""}`;
  if (itemId) throw new Error("the chats view is addressed by session, not by item id");
  return `${b}/${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`;
}

function decodeSegment(seg: string): string | null {
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

export function parseDeepLink(
  base: string,
  pathname: string,
  search: string,
): { view: string | null; session: string | null; item: string | null } {
  const params = new URLSearchParams(search);
  const b = base.replace(/\/$/, "");
  const rel = pathname.startsWith(b) ? pathname.slice(b.length) : pathname;
  const segments = rel.replace(/^\/+/, "").split("/");
  const requestedView = params.get("view") ?? decodeSegment(segments[0] ?? "");
  const view = requestedView === "connectors" ? "keychain" : requestedView;
  return { view, session: params.get("session"), item: decodeSegment(segments[1] ?? "") };
}

export function sessionLink(origin: string, base: string, sessionId: string): string {
  return `${origin}${deepLinkPath(base, "chats", sessionId)}`;
}
