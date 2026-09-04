import { parseScopeId } from "../../../types.ts";
import { ByteSourceTooLargeError } from "../../../files/durable-byte-store.ts";
import { fileArtifactId } from "../../../files/file-artifact-store.ts";
import { MAX_ATTACHMENT_BYTES, mimeFromName, safeAttachmentName } from "../../../core/attachments.ts";
import { contentDispositionAttachment, contentTypeWithUtf8Charset, pipeToResponse, sendJson } from "../../http.ts";
import { audit, authorizeAdmin, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { discoverScopes, FILES_PAGE_SIZE } from "./common.ts";

const FILE_PREVIEW_MAX_BYTES = 256 * 1024;
const FILES_LIST_MAX = 2000;

export async function readAdminFile(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const id = url.searchParams.get("id") ?? "";
  if (!id) return sendJson(res, 400, { error: "bad_request", message: "id required" });
  if (!deps.files) return sendJson(res, 404, { error: "not_found" });
  const art = await deps.files.get(id);
  if (!art) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, art.ownerScopeId);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "file.read", resource: art.path, scopeLabel: art.ownerScopeId });
  const opened = await deps.files.open(id);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of opened.stream) {
    const b = chunk as Buffer;
    if (total + b.length >= FILE_PREVIEW_MAX_BYTES) {
      chunks.push(b.subarray(0, FILE_PREVIEW_MAX_BYTES - total));
      truncated = true;
      opened.stream.destroy();
      break;
    }
    chunks.push(b);
    total += b.length;
  }
  const content = Buffer.concat(chunks).toString("utf8");
  return sendJson(res, 200, {
    id: art.id,
    scopeId: art.ownerScopeId,
    path: art.path,
    name: art.name,
    mimetype: art.mimetype,
    content,
    truncated,
  });
}

export async function downloadAdminFile(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const id = url.searchParams.get("id") ?? "";
  if (!id) return sendJson(res, 400, { error: "bad_request", message: "id required" });
  if (!deps.files) return sendJson(res, 404, { error: "not_found" });
  const art = await deps.files.get(id);
  if (!art) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, art.ownerScopeId);
  if (!actor) return;
  const mime = art.mimetype.split(";")[0]!.trim().toLowerCase();
  const inline = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/.test(mime);
  audit(deps, {
    principalId: actor.id,
    action: inline ? "file.view" : "file.download",
    resource: art.path,
    scopeLabel: art.ownerScopeId,
  });
  const opened = await deps.files.open(id);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": inline ? contentTypeWithUtf8Charset(art.mimetype) : "application/octet-stream",
    "content-length": String(opened.sizeBytes),
    "content-disposition": contentDispositionAttachment(art.name, inline ? "inline" : "attachment"),
    "x-content-type-options": "nosniff",
    ...(inline ? { "cache-control": "private, max-age=300", "content-security-policy": "sandbox" } : {}),
  });
  pipeToResponse(res, opened.stream, "file read failed");
  return;
}

export async function listAdminFiles(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "files.read", resource: "files", scopeLabel: scope });
  if (!deps.files) return sendJson(res, 200, { scopeId: scope, files: [] });
  const orgWide = parseScopeId(scope).kind === "org";
  const scopes = orgWide ? [...(await discoverScopes(app, deps)).keys()] : [scope];
  const files: Array<{
    id: string;
    scopeId: string;
    name: string;
    path: string;
    mimetype: string;
    size: number;
    direction: string;
    createdAt: number;
    openable: boolean;
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await deps.files.listOwnedByScopes(scopes, { limit: FILES_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    for (const a of page.files) {
      files.push({
        id: a.id,
        scopeId: a.ownerScopeId,
        name: a.name,
        path: a.path,
        mimetype: a.mimetype,
        size: a.sizeBytes,
        direction: a.direction,
        createdAt: a.createdAt,
        openable: a.blobKey != null,
      });
    }
    cursor = page.nextCursor;
  } while (cursor && files.length < FILES_LIST_MAX);
  return sendJson(res, 200, { scopeId: scope, files });
}

export async function uploadAdminFile(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  if (!deps.files) return sendJson(res, 404, { error: "not_found", message: "file store not wired" });
  if (!deps.blobTransfer)
    return sendJson(res, 501, { error: "not_configured", message: "blob transfer store not wired" });
  const { actor, scope } = authz;
  const b = body as { blobId?: unknown; name?: unknown; mimetype?: unknown };
  const blobId = typeof b.blobId === "string" ? b.blobId.trim() : "";
  const name = safeAttachmentName(typeof b.name === "string" ? b.name : "");
  const mimetype =
    (typeof b.mimetype === "string" && b.mimetype ? b.mimetype : mimeFromName(name))
      .split(";")[0]!
      .trim()
      .toLowerCase() || mimeFromName(name);
  if (!blobId) return sendJson(res, 400, { error: "bad_request", message: "blobId required" });
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return sendJson(res, 404, { error: "not_found", message: "staged blob not found" });
  const id = fileArtifactId(`admin-upload:${actor.id}:${scope}:${Date.now()}:${blobId}`, "in", 0);
  const path = `artifacts/${id}/${name}`;
  try {
    const { artifact } = await deps.files.put({
      id,
      ownerScopeId: scope,
      createdBy: actor.id,
      name,
      path,
      mimetype,
      data: opened.stream,
      direction: "in",
      createdInScope: scope,
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    audit(deps, { principalId: actor.id, action: "file.upload", resource: path, scopeLabel: scope });
    return sendJson(res, 200, {
      file: {
        id: artifact.id,
        scopeId: artifact.ownerScopeId,
        name: artifact.name,
        path: artifact.path,
        mimetype: artifact.mimetype,
        size: artifact.sizeBytes,
        direction: artifact.direction,
        createdAt: artifact.createdAt,
        openable: artifact.blobKey != null,
      },
    });
  } catch (e) {
    if (e instanceof ByteSourceTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: e.message });
    throw e;
  } finally {
    await deps.blobTransfer.delete(blobId);
  }
}
