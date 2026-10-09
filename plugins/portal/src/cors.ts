import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "content-type";
const EXPOSED_HEADERS = "content-disposition";
const PREFLIGHT_MAX_AGE_S = 600;

const ID = "[^/]+";
const FILE_ID = "(?!by-name(?:/|$))[^/]+";
const CHAT_API_ROUTES: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: "GET", re: /^\/me$/ },
  { method: "POST", re: /^\/api\/turn$/ },
  { method: "GET", re: /^\/api\/runs\/active$/ },
  { method: "GET", re: new RegExp(`^/api/runs/${ID}$`) },
  { method: "GET", re: new RegExp(`^/api/runs/${ID}/events$`) },
  { method: "POST", re: new RegExp(`^/api/runs/${ID}/signal$`) },
  { method: "POST", re: new RegExp(`^/api/runs/${ID}/withdraw$`) },
  { method: "GET", re: /^\/api\/sessions$/ },
  { method: "GET", re: new RegExp(`^/api/sessions/${ID}$`) },
  { method: "GET", re: new RegExp(`^/api/sessions/${ID}/approvals$`) },
  { method: "POST", re: new RegExp(`^/api/approvals/${ID}$`) },
  { method: "POST", re: /^\/api\/blobs$/ },
  { method: "GET", re: new RegExp(`^/api/files/${FILE_ID}/content(?:/${ID})?$`) },
];

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
  return CHAT_API_ROUTES.some((route) => route.method === method && route.re.test(pathname));
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
