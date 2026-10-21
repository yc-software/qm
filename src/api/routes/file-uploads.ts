import { readFile } from "node:fs/promises";
import { sendJson } from "../http.ts";
import { scopeId, type ScopeId } from "../../types.ts";
import { FileUploadError } from "../../files/file-upload-store.ts";
import { isObj, audit } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

type Uploads = NonNullable<ApiCtx["deps"]["fileUploads"]>;
type Upload = NonNullable<Awaited<ReturnType<Uploads["get"]>>>;

const uploadRoute =
  (handle: (ctx: ApiCtx, uploads: Uploads, actorId: string) => Promise<void>) =>
  async (ctx: ApiCtx): Promise<void> => {
    const { res, deps, capability, actor } = ctx;
    const uploads = deps.fileUploads;
    if (!uploads)
      return sendJson(res, 501, { error: "not_configured", message: "direct uploads require S3 and Postgres" });
    const actorId = capability?.actorId ?? actor?.p;
    if (!actorId) return sendJson(res, 401, { error: "actor_required" });
    try {
      return await handle(ctx, uploads, actorId);
    } catch (error) {
      if (error instanceof FileUploadError)
        return sendJson(res, error.status, { error: error.code, message: error.message });
      throw error;
    }
  };

const ownedUpload = (handle: (ctx: ApiCtx, uploads: Uploads, upload: Upload, actorId: string) => Promise<void>) =>
  uploadRoute(async (ctx, uploads, actorId) => {
    const { res, app, capability, params } = ctx;
    const upload = await uploads.get(params.id!);
    if (
      !upload ||
      upload.actorId !== actorId ||
      (capability && upload.scopeId !== capability.scopeId) ||
      !(await app.belongsToScope(actorId, upload.scopeId))
    )
      return sendJson(res, 404, { error: "not_found" });
    return handle(ctx, uploads, upload, actorId);
  });

const uploadClient = uploadRoute(async ({ res }) => {
  const script = await readFile(new URL("../../files/upload-client.py", import.meta.url), "utf8");
  res.writeHead(200, { "content-type": "text/x-python; charset=utf-8", "cache-control": "private, max-age=300" });
  res.end(script);
});

const beginUpload = uploadRoute(async (ctx, uploads, actorId) => {
  const { res, deps, app, capability } = ctx;
  const body = isObj(ctx.body) ? ctx.body : {};
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
});

const getUpload = ownedUpload(async ({ res }, _uploads, upload) => sendJson(res, 200, { upload }));

const signPart = ownedUpload(async ({ res, params }, uploads, upload) =>
  sendJson(res, 200, await uploads.sign(upload.id, Number(params.part))),
);

const completeUpload = ownedUpload(async ({ res, deps }, uploads, upload, actorId) => {
  const file = await uploads.complete(upload.id);
  audit(deps, { principalId: actorId, action: "file.upload", resource: file.path, scopeLabel: upload.scopeId });
  return sendJson(res, 200, { file, contentUrl: `/v1/files/${file.id}/content` });
});

const abortUpload = ownedUpload(async ({ res, deps }, uploads, upload, actorId) => {
  await uploads.abort(upload.id);
  audit(deps, { principalId: actorId, action: "file.upload.abort", resource: upload.id, scopeLabel: upload.scopeId });
  return sendJson(res, 200, { ok: true });
});

export const fileUploadRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/files/upload-client", actor: "query.viewer", auth: "either", handle: uploadClient },
  { method: "GET", path: "/v1/files/uploads/:id", actor: "query.viewer", auth: "either", handle: getUpload },
  ...withActor("body.principalId", [
    { method: "POST", path: "/v1/files/uploads", auth: "either", handle: beginUpload },
    { method: "POST", path: "/v1/files/uploads/:id/parts/:part", auth: "either", handle: signPart },
    { method: "POST", path: "/v1/files/uploads/:id/complete", auth: "either", handle: completeUpload },
    { method: "DELETE", path: "/v1/files/uploads/:id", auth: "either", handle: abortUpload },
  ]),
];
