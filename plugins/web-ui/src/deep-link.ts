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
  return sessionId ? `${b}/s/${encodeURIComponent(sessionId)}` : `${b}/`;
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
  const pathView = decodeSegment(segments[0] ?? "");
  const projectKind = segments[1] === "channel" || segments[1] === "group" ? segments[1] : null;
  let projectItem: string | null = null;
  if (pathView === "projects") {
    projectItem = projectKind ? decodeSegment(segments[2] ?? "") : decodeSegment(segments[1] ?? "");
  }
  const sessionSeg = pathView === "s" ? decodeSegment(segments[1] ?? "") : null;
  let fallbackView = pathView;
  if (pathView === "projects") fallbackView = "contexts";
  else if (pathView === "s") fallbackView = "chats";
  const requestedView = params.get("view") ?? fallbackView;
  const view = requestedView === "connectors" ? "keychain" : requestedView;
  return {
    view,
    session: sessionSeg ?? params.get("session"),
    item: itemFor(pathView, projectKind, projectItem, segments),
  };
}

function itemFor(
  pathView: string | null,
  projectKind: string | null,
  projectItem: string | null,
  segments: string[],
): string | null {
  if (pathView === "s") return null;
  if (pathView === "projects" && projectKind && projectItem) return `${projectKind}:${projectItem}`;
  return projectItem ?? decodeSegment(segments[1] ?? "");
}

export function sessionLink(origin: string, base: string, sessionId: string): string {
  return `${origin}${deepLinkPath(base, "chats", sessionId)}`;
}

/** True for an unmodified left click — the case an in-app link should handle itself (SPA nav). Modified clicks (cmd/ctrl/shift/alt, middle-click) fall through to the browser so "open in new tab" works. */
export function isPlainLeftClick(e: MouseEvent): boolean {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}
