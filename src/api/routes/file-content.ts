import { relayStream } from "../../../plugins/chassis/src/http.ts";
import type { OpenedFile } from "../app-types.ts";
import { errMessage } from "../../util/errors.ts";
import { contentTypeWithUtf8Charset, sendJson } from "../http.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

const UNTRUSTED_CONTENT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

const PLAYGROUND_CSP = [
  "sandbox allow-scripts allow-pointer-lock",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const BY_NAME_PAGES = 50;

function scriptCapable(contentType: string): boolean {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "image/svg+xml" ||
    mime === "text/xml" ||
    mime === "application/xml" ||
    mime.endsWith("+xml")
  );
}

function viewerOf(ctx: ApiCtx): string | null {
  const viewer = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!viewer) sendJson(ctx.res, 401, { error: "capability_required" });
  return viewer ?? null;
}

async function openForViewer(ctx: ApiCtx): Promise<(OpenedFile & { contentType: string }) | null> {
  const viewer = viewerOf(ctx);
  if (!viewer) return null;
  const opened = await ctx.app.openFileForViewer(ctx.params.id!, viewer);
  if (!opened) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  return { ...opened, contentType: contentTypeWithUtf8Charset(opened.mimetype || "application/octet-stream") };
}

function streamFile(ctx: ApiCtx, opened: OpenedFile): void {
  const id = ctx.params.id!;
  relayStream(opened.stream, ctx.res, {
    onError: (error) => console.warn(`[files] file ${id} stream ended early: ${errMessage(error)}`),
  });
}

async function getFileContent(ctx: ApiCtx): Promise<void> {
  const opened = await openForViewer(ctx);
  if (!opened) return;
  const appsDomain = ctx.deps.deployAppsDomain?.toLowerCase();
  const ancestors = appsDomain ? `frame-ancestors 'self' *.${appsDomain}` : "frame-ancestors 'self'";
  ctx.res.removeHeader("x-frame-options");
  ctx.res.writeHead(200, {
    "content-type": opened.contentType,
    "content-length": String(opened.sizeBytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
    "content-security-policy": scriptCapable(opened.contentType)
      ? `${UNTRUSTED_CONTENT_SANDBOX_CSP}; ${ancestors}`
      : ancestors,
    "x-content-type-options": "nosniff",
  });
  streamFile(ctx, opened);
}

async function getPlayground(ctx: ApiCtx): Promise<void> {
  const opened = await openForViewer(ctx);
  if (!opened) return;
  if (!opened.contentType.toLowerCase().startsWith("text/html")) {
    opened.stream.destroy();
    return sendJson(ctx.res, 415, { error: "not_a_playground" });
  }
  ctx.res.writeHead(200, {
    "content-type": ctx.url.searchParams.get("source") === "1" ? "text/plain; charset=utf-8" : opened.contentType,
    "content-security-policy": PLAYGROUND_CSP,
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  });
  streamFile(ctx, opened);
}

async function getFileByName(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const name = url.searchParams.get("name")?.trim();
  if (!name) return sendJson(res, 400, { error: "bad_request", message: "name required" });
  const viewer = viewerOf(ctx);
  if (!viewer) return;
  let cursor: string | undefined;
  let match: { id: string; createdAt: number } | undefined;
  for (let page = 0; page < BY_NAME_PAGES; page++) {
    const listed = await app.listFilesForViewer(viewer, { limit: 200, nameQuery: name, ...(cursor ? { cursor } : {}) });
    for (const file of [...listed.owned, ...listed.shared]) {
      if (file.name !== name || !file.openable) continue;
      if (!match || file.createdAt > match.createdAt) match = { id: file.id, createdAt: file.createdAt };
    }
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  if (!match) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(302, { location: `/api/files/${encodeURIComponent(match.id)}/content` });
  res.end();
}

export const fileContentRoutes: Route[] = withActor("query.viewer", [
  { method: "GET", path: "/v1/files/by-name/content", browser: true, auth: "source", handle: getFileByName },
  { method: "GET", path: "/v1/files/:id/content", browser: true, auth: "either", handle: getFileContent },
  { method: "GET", path: "/v1/playgrounds/:id", browser: true, auth: "source", handle: getPlayground },
]);
