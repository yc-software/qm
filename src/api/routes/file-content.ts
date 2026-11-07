import { relayStream } from "../../../plugins/chassis/src/http.ts";
import { errMessage } from "../../util/errors.ts";
import {
  contentTypeWithUtf8Charset,
  frameAncestorsDirective,
  sendJson,
  sendRedirect,
  UNTRUSTED_CONTENT_SANDBOX_CSP,
} from "../http.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

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

function viewerOf(ctx: ApiCtx): string | null {
  const viewer = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!viewer) sendJson(ctx.res, 401, { error: "capability_required" });
  return viewer ?? null;
}

async function openForViewer(ctx: ApiCtx) {
  const viewer = viewerOf(ctx);
  if (!viewer) return null;
  const opened = await ctx.app.openFileForViewer(ctx.params.id!, viewer);
  if (!opened) sendJson(ctx.res, 404, { error: "not_found" });
  return opened;
}

function streamFile(ctx: ApiCtx, stream: NodeJS.ReadableStream): void {
  const id = ctx.params.id!;
  relayStream(stream, ctx.res, {
    onError: (error) => console.warn(`[files] file ${id} stream ended early: ${errMessage(error)}`),
  });
}

async function getFileContent(ctx: ApiCtx): Promise<void> {
  const opened = await openForViewer(ctx);
  if (!opened) return;
  const contentType = contentTypeWithUtf8Charset(opened.mimetype);
  const appsDomain = ctx.deps.deployAppsDomain;
  const ancestors = frameAncestorsDirective(appsDomain ? [`*.${appsDomain}`] : []);
  ctx.res.removeHeader("x-frame-options");
  ctx.res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(opened.sizeBytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
    "content-security-policy":
      contentType === "application/pdf" ? ancestors : `${UNTRUSTED_CONTENT_SANDBOX_CSP}; ${ancestors}`,
    "x-content-type-options": "nosniff",
  });
  streamFile(ctx, opened.stream);
}

async function getPlayground(ctx: ApiCtx): Promise<void> {
  const opened = await openForViewer(ctx);
  if (!opened) return;
  const contentType = contentTypeWithUtf8Charset(opened.mimetype);
  if (!contentType.toLowerCase().startsWith("text/html")) {
    opened.stream.destroy();
    return sendJson(ctx.res, 415, { error: "not_a_playground" });
  }
  ctx.res.writeHead(200, {
    "content-type": ctx.url.searchParams.get("source") === "1" ? "text/plain; charset=utf-8" : contentType,
    "content-security-policy": PLAYGROUND_CSP,
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  });
  streamFile(ctx, opened.stream);
}

async function getFileByName(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const name = url.searchParams.get("name")?.trim();
  if (!name) return sendJson(res, 400, { error: "bad_request", message: "name required" });
  const viewer = viewerOf(ctx);
  if (!viewer) return;
  let cursor: string | undefined;
  do {
    const listed = await app.listFilesForViewer(viewer, { limit: 200, name, ...(cursor ? { cursor } : {}) });
    const newest = [...listed.owned, ...listed.shared]
      .filter((file) => file.openable)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest) return sendRedirect(res, `/api/files/${encodeURIComponent(newest.id)}/content`);
    cursor = listed.nextCursor;
  } while (cursor);
  return sendJson(res, 404, { error: "not_found" });
}

export const fileContentRoutes: Route[] = withActor("query.viewer", [
  { method: "GET", path: "/v1/files/by-name/content", browser: true, auth: "source", handle: getFileByName },
  { method: "GET", path: "/v1/files/:id/content", browser: true, auth: "either", handle: getFileContent },
  { method: "GET", path: "/v1/playgrounds/:id", browser: true, auth: "source", handle: getPlayground },
]);
