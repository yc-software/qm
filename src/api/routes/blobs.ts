import { verifyBlobTransferCapability } from "../../auth/capability-token.ts";
import { BlobHashMismatchError, BlobTooLargeError, MAX_BLOB_BYTES } from "../../persistence/blob-transfer.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { canonicalPayload, headerValue, pipeToResponse, sendJson, verifyOrReject } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

type BlobDir = "read" | "write";

async function authorizeBlob(ctx: BaseCtx, dir: BlobDir, blobId: string | null): Promise<boolean> {
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
      return false;
    }
    if (!(await ctx.app.authorizesCapabilityScope(claims))) {
      req.resume();
      sendJson(res, 403, { error: "forbidden", message: "capability scope membership has been revoked" });
      return false;
    }
    return true;
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
    return false;
  }
  return true;
}

async function putBlob(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.blobTransfer) {
    req.resume();
    return sendJson(res, 501, { error: "not_configured", message: "no blob transfer store wired" });
  }
  const declaredSha = headerValue(req, "x-content-sha256") ?? "";
  if (ctx.secret && !headerValue(req, CAPABILITY_HEADER) && !/^[0-9a-f]{64}$/.test(declaredSha)) {
    req.resume();
    return sendJson(res, 400, { error: "bad_request", message: "x-content-sha256 (hex sha-256) required" });
  }
  if (!(await authorizeBlob(ctx, "write", null))) return;
  try {
    const info = await deps.blobTransfer.put(req, {
      maxBytes: MAX_BLOB_BYTES,
      ...(declaredSha ? { expectedSha256: declaredSha } : {}),
    });
    return sendJson(res, 200, { blobId: info.blobId, sizeBytes: info.sizeBytes });
  } catch (e) {
    req.resume();
    if (e instanceof BlobTooLargeError) return sendJson(res, 413, { error: "payload_too_large", message: e.message });
    if (e instanceof BlobHashMismatchError) return sendJson(res, 400, { error: "hash_mismatch", message: e.message });
    throw e;
  }
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
  pipeToResponse(res, blob.stream, "blob read failed");
  return;
}

export const blobRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/blobs", auth: "either", handle: putBlob },
  { method: "GET", path: "/v1/blobs/:id", auth: "either", handle: getBlob },
];
