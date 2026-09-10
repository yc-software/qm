import { readFile } from "node:fs/promises";
import { sendJson } from "../http.ts";
import { scopeId, type ScopeId } from "../../types.ts";
import { FileUploadError } from "../../files/direct-file-upload.ts";
import { isObj, audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function handleUpload(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, capability, actor, params, method, pathname } = ctx;
  const uploads = deps.fileUploads;
  if (!uploads)
    return sendJson(res, 501, { error: "not_configured", message: "direct uploads require S3 and Postgres" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const actorId = capability?.actorId ?? actor?.p;
  if (!actorId) return sendJson(res, 401, { error: "actor_required" });
  try {
    if (!deps.filesDirectUploadsEnabled && !params.id && pathname !== "/v1/files/upload-client")
      return sendJson(res, 503, { error: "uploads_disabled", message: "new direct uploads are disabled" });
    if (pathname === "/v1/files/upload-client") {
      const script = await readFile(new URL("../../files/upload-client.py", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/x-python; charset=utf-8", "cache-control": "private, max-age=300" });
      res.end(script);
      return;
    }
    if (!params.id) {
      const targetScope =
        typeof body.scopeId === "string"
          ? (body.scopeId as ScopeId)
          : (capability?.scopeId ?? scopeId("personal", actorId));
      if ((capability && targetScope !== capability.scopeId) || !(await app.belongsToScope(actorId, targetScope)))
        return sendJson(res, 403, { error: "forbidden" });
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 512 ||
        (body.mimetype != null && (typeof body.mimetype !== "string" || body.mimetype.length > 256))
      )
        throw new FileUploadError("name and optional mimetype must be valid strings");
      const rate = await deps.rateLimiter?.check(`file-uploads:${actorId}`);
      if (rate && !rate.allowed) return sendJson(res, 429, { error: "rate_limited" });
      const upload = await uploads.begin({
        actorId,
        scopeId: targetScope,
        name: body.name,
        mimetype: typeof body.mimetype === "string" ? body.mimetype : "",
        sizeBytes: body.sizeBytes as number,
        checksums: body.checksums as string[],
        ...(body.requestId != null ? { requestId: body.requestId as string } : {}),
      });
      audit(deps, { principalId: actorId, action: "file.upload.begin", resource: upload.id, scopeLabel: targetScope });
      return sendJson(res, 201, { upload });
    }
    const upload = await uploads.get(params.id);
    if (
      !upload ||
      upload.actorId !== actorId ||
      (capability && upload.scopeId !== capability.scopeId) ||
      !(await app.belongsToScope(actorId, upload.scopeId))
    )
      return sendJson(res, 404, { error: "not_found" });
    if (method === "GET") return sendJson(res, 200, { upload });
    if (params.part) return sendJson(res, 200, await uploads.sign(upload.id, Number(params.part)));
    if (pathname.endsWith("/complete")) {
      const file = await uploads.complete(upload.id);
      audit(deps, { principalId: actorId, action: "file.upload", resource: file.path, scopeLabel: upload.scopeId });
      return sendJson(res, 200, { file, contentUrl: `/v1/files/${file.id}/content` });
    }
    await uploads.abort(upload.id);
    audit(deps, { principalId: actorId, action: "file.upload.abort", resource: upload.id, scopeLabel: upload.scopeId });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof FileUploadError)
      return sendJson(res, error.status, { error: "upload_error", message: error.message });
    if (error instanceof Error && error.message === "active upload quota exceeded")
      return sendJson(res, 429, { error: "upload_quota", message: error.message });
    throw error;
  }
}

export const fileUploadRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/files/upload-client", auth: "either", handle: handleUpload },
  { method: "POST", path: "/v1/files/uploads", auth: "either", handle: handleUpload },
  { method: "GET", path: "/v1/files/uploads/:id", auth: "either", handle: handleUpload },
  { method: "POST", path: "/v1/files/uploads/:id/parts/:part", auth: "either", handle: handleUpload },
  { method: "POST", path: "/v1/files/uploads/:id/complete", auth: "either", handle: handleUpload },
  { method: "DELETE", path: "/v1/files/uploads/:id", auth: "either", handle: handleUpload },
];
