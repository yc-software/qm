export function appGitParts(pathname: string): { id: string; tail: string } | null {
  const prefix = "/v1/apps/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const marker = "/git/";
  const markerAt = rest.indexOf(marker);
  if (markerAt < 0) return null;
  const tail = rest.slice(markerAt + marker.length);
  if (!tail) return null;
  try {
    return { id: decodeURIComponent(rest.slice(0, markerAt)), tail };
  } catch {
    return null;
  }
}

export function isAppGitRoute(method: string, pathname: string): boolean {
  const parts = appGitParts(pathname);
  if (!parts) return false;
  return (
    (method === "GET" && parts.tail === "info/refs") ||
    (method === "POST" && (parts.tail === "git-upload-pack" || parts.tail === "git-receive-pack"))
  );
}
