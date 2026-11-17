import { compilePath } from "../../chassis/src/router.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "content-type";
const EXPOSED_HEADERS = "content-disposition";
const PREFLIGHT_MAX_AGE_S = 600;

const CHAT_API_ROUTES = [
  { method: "GET", path: "/me" },
  { method: "POST", path: "/api/turn" },
  { method: "GET", path: "/api/contexts" },
  { method: "POST", path: "/api/projects" },
  { method: "POST", path: "/api/skills" },
  { method: "POST", path: "/api/skills/:skillId/share" },
  { method: "GET", path: "/api/runs/active" },
  { method: "GET", path: "/api/runs/:runId" },
  { method: "GET", path: "/api/runs/:runId/events" },
  { method: "POST", path: "/api/runs/:runId/signal" },
  { method: "POST", path: "/api/runs/:runId/withdraw" },
  { method: "GET", path: "/api/sessions" },
  { method: "GET", path: "/api/sessions/:sessionId" },
  { method: "GET", path: "/api/sessions/:sessionId/approvals" },
  { method: "POST", path: "/api/approvals/:approvalId" },
  { method: "POST", path: "/api/blobs" },
  { method: "GET", path: "/api/files/:fileId/content" },
  { method: "GET", path: "/api/files/:fileId/content/:name" },
].map(({ method, path }) => ({ method, match: compilePath(path) }));

export function parseAllowedOrigins(raw: string | undefined): { origins: Set<string>; problems: string[] } {
  const origins = new Set<string>();
  const problems: string[] = [];
  for (const entry of (raw ?? "").split(",").map((part) => part.trim())) {
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`PORTAL_API_ALLOWED_ORIGINS entry "${entry}" is not a URL`);
      continue;
    }
    if (url.origin !== entry) {
      problems.push(
        `PORTAL_API_ALLOWED_ORIGINS entry "${entry}" must be a bare origin (scheme, host and optional port, no path or trailing slash), e.g. "${url.origin}"`,
      );
      continue;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      problems.push(`PORTAL_API_ALLOWED_ORIGINS entry "${entry}" must use https`);
      continue;
    }
    origins.add(url.origin);
  }
  return { origins, problems };
}

export function isChatApiRoute(method: string, pathname: string): boolean {
  return CHAT_API_ROUTES.some((route) => {
    if (route.method !== method) return false;
    const params: Record<string, string> = {};
    return (
      route.match.test(method, pathname, params) && Object.values(params).every(Boolean) && params.fileId !== "by-name"
    );
  });
}

export function prepareCors(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (allowed.size === 0) return undefined;
  const method = req.method === "OPTIONS" ? String(req.headers["access-control-request-method"] ?? "") : req.method;
  if (!isChatApiRoute(method ?? "", pathname)) return undefined;
  res.setHeader("vary", "Origin");
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !allowed.has(origin)) return undefined;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-expose-headers", EXPOSED_HEADERS);
  return origin;
}

export function answerPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
    "cache-control": "no-store",
  });
  res.end();
}
