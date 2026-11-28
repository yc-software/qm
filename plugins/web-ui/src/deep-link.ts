import { messageLinkSeq } from "./message-link.ts";

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
  if (view !== "chats") {
    const segment = view === "personas" ? "bots" : view;
    return `${b}/${encodeURIComponent(segment)}${itemId ? `/${encodeURIComponent(itemId)}` : ""}`;
  }
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
  const sessionRoute = pathView === "s" || pathView === "c" || pathView === "sessions";
  const sessionSeg = sessionRoute ? decodeSegment(segments[1] ?? "") : null;
  const viewFor = (): string | null => {
    if (pathView === "projects") return "contexts";
    if (pathView === "bots") return "personas";
    if (sessionRoute) return "chats";
    return pathView;
  };
  const requestedView = params.get("view") ?? viewFor();
  let view = requestedView;
  if (view === "connectors") view = "keychain";
  const itemFor = (): string | null => {
    if (sessionRoute) return null;
    if (pathView === "projects" && projectKind && projectItem) return `${projectKind}:${projectItem}`;
    return projectItem ?? decodeSegment(segments[1] ?? "");
  };
  return {
    view,
    session: sessionSeg ?? params.get("session"),
    item: itemFor(),
  };
}

export function sessionLink(origin: string, base: string, sessionId: string, seq?: number): string {
  const suffix = seq !== undefined && Number.isSafeInteger(seq) && seq >= 0 ? `?seq=${seq}` : "";
  return `${origin}${deepLinkPath(base, "chats", sessionId)}${suffix}`;
}

function inAppLink(
  href: string,
  origin: string,
  base: string,
): { url: URL; view: string | null; session: string | null } | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  const b = base.replace(/\/$/, "");
  if (url.origin !== origin || (b && url.pathname !== b && !url.pathname.startsWith(`${b}/`))) return null;
  return { url, ...parseDeepLink(b, url.pathname, url.search) };
}

export function sessionLinkTarget(
  href: string,
  origin: string,
  base: string,
): { session: string; seq: number | null } | null {
  const link = inAppLink(href, origin, base);
  if (link?.view !== "chats" || !link.session) return null;
  return { session: link.session, seq: messageLinkSeq(link.url.search) };
}

export function fileLinkTarget(href: string, origin: string, base: string): string | null {
  const link = inAppLink(href, origin, base);
  return link?.view === "files" ? link.url.searchParams.get("file") : null;
}

export function isPlainLeftClick(e: MouseEvent): boolean {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}
