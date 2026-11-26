import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { brokerClient, CalendarError, listEvents, respond } from "./google.mjs";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const PUBLIC_DIR = join(import.meta.dirname, "public");
const assets = new Map(
  readdirSync(PUBLIC_DIR).map((name) => [
    name === "index.html" ? "/" : `/${name}`,
    { body: readFileSync(join(PUBLIC_DIR, name)), type: `${TYPES[extname(name)] ?? "text/plain"}; charset=utf-8` },
  ]),
);

const owner = (process.env.QM_APP_OWNER ?? "").toLowerCase();
const google = brokerClient({
  apiUrl: process.env.AGENT_API_URL ?? "",
  token: process.env.AGENT_CREDENTIAL_TOKEN ?? "",
});

export function viewerOf(header, key, now = Date.now()) {
  const parts = typeof header === "string" ? header.split(".") : [];
  if (parts.length !== 3 || !key) return null;
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (typeof claims.p !== "string" || typeof claims.exp !== "number" || now > claims.exp) return null;
  return claims.p.toLowerCase();
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function api(req, res, url) {
  const viewer = viewerOf(req.headers["x-portal-identity"], process.env.VIEWER_IDENTITY_KEY);
  if (!viewer || viewer !== owner)
    return send(res, 403, { error: "forbidden", message: "This calendar belongs to the person who owns the app." });
  const [, , resource, calendarId, eventId] = url.pathname.split("/").map(decodeURIComponent);
  if (resource !== "events") return send(res, 404, { error: "not_found" });
  if (req.method === "GET" && !calendarId)
    return send(res, 200, await listEvents(google, url.searchParams.get("timeMin"), url.searchParams.get("timeMax")));
  if (req.method === "PATCH" && calendarId && eventId) {
    const { responseStatus } = await readJson(req);
    return send(res, 200, await respond(google, calendarId, eventId, responseStatus));
  }
  return send(res, 405, { error: "method_not_allowed" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://app");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== "GET") return send(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
    res.end(asset.body);
  } catch (error) {
    if (error instanceof CalendarError)
      return send(res, error.status, { error: error.code, message: error.message, ...error.extra });
    console.error("calendar:", error);
    send(res, 500, { error: "internal", message: "Something went wrong loading your calendar." });
  }
});

if (process.env.PORT) server.listen(Number(process.env.PORT));
