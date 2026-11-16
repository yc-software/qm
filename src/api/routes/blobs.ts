import { finished, PassThrough } from "node:stream";
import { verifyBlobTransferCapability } from "../../auth/capability-token.ts";
import { ByteSourceTooLargeError } from "../../files/durable-byte-store.ts";
import type { ScopeId } from "../../types.ts";
import {
  type BlobInfo,
  BlobHashMismatchError,
  BlobTooLargeError,
  MAX_BLOB_BYTES,
  MAX_STAGE_BLOB_BYTES,
} from "../../persistence/blob-transfer.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { tenantOf, usesBrowserSession } from "./route.ts";
import { canonicalPayload } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { extendBodyDeadline, headerValue, sendJson, verifyOrReject } from "../http.ts";
import { relayStream } from "../../../plugins/chassis/src/http.ts";

const STAGE_UPLOAD_DEADLINE_MS = 1_800_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

type BlobDir = "read" | "write";

type BlobAuthz = { via: "capability" | "source" } | null;

async function authorizeBlob(ctx: BaseCtx, dir: BlobDir, blobId: string | null): Promise<BlobAuthz> {
  const { req, res, secret, auth, url, pathname, method } = ctx;
  const capSecret = ctx.deps.capabilitySecret ?? secret;
  const capToken = headerValue(req, CAPABILITY_HEADER);
  if (capSecret && capToken) {
    const claims = await verifyBlobTransferCapability(
      capToken,
      capSecret,
      dir === "read" ? { dir, id: blobId ?? "" } : { dir },
    );
    if (!claims) {
      req.resume();
      sendJson(res, 403, { error: "forbidden", message: "blob-transfer capability token not valid for this transfer" });
      return null;
    }
    if (!(await ctx.app.authorizesCapabilityScope(claims))) {
      req.resume();
      sendJson(res, 403, {
        error: "forbidden",
        message: "the acting user is not currently authorized for this conversation",
      });
      return null;
    }
    return { via: "capability" };
  }
  const tail = method === "POST" ? (headerValue(req, "x-content-sha256") ?? "") : "";
  if (
    !(await verifyOrReject(
      req,
      res,
      secret,
      auth,
      canonicalPayload(method, pathname + url.search, tail),
      false,
      ctx.allowUnsignedSourceAuth,
    ))
  ) {
    req.resume();
    return null;
  }
  return { via: "source" };
}

async function putBlob(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.blobTransfer) {
    req.resume();
    return sendJson(res, 501, { error: "not_configured", message: "no blob transfer store wired" });
  }
  const declaredSha = headerValue(req, "x-content-sha256") ?? "";
  if (ctx.secret && !headerValue(req, CAPABILITY_HEADER) && !SHA256_HEX.test(declaredSha)) {
    req.resume();
    return sendJson(res, 400, { error: "bad_request", message: "x-content-sha256 (hex sha-256) required" });
  }
  const authz = await authorizeBlob(ctx, "write", null);
  if (!authz) return;
  const info = await stageRequestBlob(
    ctx,
    authz.via === "capability" ? MAX_STAGE_BLOB_BYTES : MAX_BLOB_BYTES,
    declaredSha,
  );
  if (info) return sendJson(res, 200, { blobId: info.blobId, sizeBytes: info.sizeBytes });
}

async function stageRequestBlob(ctx: BaseCtx, maxBytes: number, sha256: string): Promise<BlobInfo | null> {
  const { req, res, deps } = ctx;
  extendBodyDeadline(req, STAGE_UPLOAD_DEADLINE_MS);
  const body = new PassThrough();
  finished(req, (error) => error && body.destroy(error));
  relayStream(req, body);
  try {
    return await deps.blobTransfer!.put(body, { maxBytes, ...(sha256 ? { expectedSha256: sha256 } : {}) });
  } catch (e) {
    req.unpipe(body);
    req.resume();
    if (e instanceof BlobTooLargeError) sendJson(res, 413, { error: "payload_too_large", message: e.message });
    else if (e instanceof BlobHashMismatchError) sendJson(res, 400, { error: "hash_mismatch", message: e.message });
    else throw e;
    return null;
  }
}

export function browserUploadFields(ctx: ApiCtx): { name: string; mimetype: string } {
  const contentType = ctx.req.headers["content-type"];
  return {
    name: ctx.url.searchParams.get("name")?.trim() || "file",
    mimetype: typeof contentType === "string" ? contentType : "application/octet-stream",
  };
}

export async function stageBrowserUpload(ctx: ApiCtx): Promise<BlobInfo | null> {
  const { req, res, deps, url } = ctx;
  if (!usesBrowserSession(req, { browser: true })) {
    sendJson(res, 401, { error: "unauthorized", message: "a sign-in session for this organization is required" });
    return null;
  }
  const sha256 = url.searchParams.get("sha") ?? "";
  if (!SHA256_HEX.test(sha256)) {
    req.resume();
    sendJson(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
    return null;
  }
  if (!deps.blobTransfer) {
    req.resume();
    sendJson(res, 501, { error: "not_configured", message: "no blob transfer store wired" });
    return null;
  }
  return stageRequestBlob(ctx, MAX_BLOB_BYTES, sha256);
}

async function putBrowserBlob(ctx: ApiCtx): Promise<void> {
  const staged = await stageBrowserUpload(ctx);
  if (staged) return sendJson(ctx.res, 200, { blobId: staged.blobId, sizeBytes: staged.sizeBytes });
}

async function getBlob(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params } = ctx;
  if (!deps.blobTransfer) {
    req.resume();
    return sendJson(res, 501, { error: "not_configured", message: "no blob transfer store wired" });
  }
  const id = params.id!;
  if (!(await authorizeBlob(ctx, "read", id))) return;
  const blob = await deps.blobTransfer.open(id);
  if (!blob) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(blob.sizeBytes) });
  relayStream(blob.stream, res);
  return;
}

async function uploadFile(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const staged = await stageBrowserUpload(ctx);
  if (!staged) return;
  const { blobId } = staged;
  const principalId = ctx.actor!.p;
  const { name, mimetype } = browserUploadFields(ctx);
  const scopeId = (url.searchParams.get("scope") || undefined) as ScopeId | undefined;
  const opened = await deps.blobTransfer!.open(blobId);
  if (!opened) return sendJson(res, 404, { error: "not_found", message: "staged blob not found" });
  try {
    const file = await app.uploadFileForViewer(tenantOf(ctx), principalId, {
      ...(scopeId ? { scopeId } : {}),
      name,
      mimetype,
      data: opened.stream,
    });
    if (!file) {
      opened.stream.destroy();
      return sendJson(res, 403, { error: "forbidden", message: "you can only upload to your own contexts" });
    }
    return sendJson(res, 200, { file });
  } catch (e) {
    if (e instanceof ByteSourceTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: e.message });
    throw e;
  } finally {
    await deps.blobTransfer!.delete(blobId);
  }
}

export const browserUploadRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/web/blobs",
    browser: "embed",
    actor: "person",
    auth: "source",
    streamBody: true,
    handle: putBrowserBlob,
  },
  {
    method: "POST",
    path: "/v1/files/upload",
    browser: true,
    actor: "person",
    auth: "source",
    streamBody: true,
    handle: uploadFile,
  },
];

export const blobRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/blobs", actor: "system", auth: "either", handle: putBlob },
  { method: "GET", path: "/v1/blobs/:id", auth: "either", handle: getBlob },
];
