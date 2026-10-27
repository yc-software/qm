import { verifyBlobTransferCapability } from "../../auth/capability-token.ts";
import {
  BlobHashMismatchError,
  BlobTooLargeError,
  MAX_BLOB_BYTES,
  MAX_STAGE_BLOB_BYTES,
} from "../../persistence/blob-transfer.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { extendBodyDeadline, fail, headerValue, pipeToResponse, verifySignedRoute } from "../http.ts";
import { type BaseCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { foreignTenant } from "../../tenants/directory.ts";

const STAGE_UPLOAD_DEADLINE_MS = 1_800_000;

function rejectBlob(ctx: BaseCtx, message: string): never {
  ctx.req.resume();
  throw fail(403, "forbidden", message);
}

async function authorizeBlob(
  ctx: BaseCtx,
  dir: "read" | "write",
  blobId: string | null,
): Promise<"capability" | "source" | null> {
  const { req, method } = ctx;
  const capSecret = ctx.deps.capabilitySecret ?? ctx.secret;
  const capToken = headerValue(req, CAPABILITY_HEADER);
  if (capSecret && capToken) {
    const claims = await verifyBlobTransferCapability(
      capToken,
      capSecret,
      dir === "read" ? { dir, id: blobId ?? "" } : { dir },
    );
    if (!claims || foreignTenant(claims.orgId, "blob transfer capability"))
      return rejectBlob(ctx, "blob-transfer capability token not valid for this transfer");
    if (!(await ctx.app.authorizesCapabilityScope(claims)))
      return rejectBlob(ctx, "the acting user is not currently authorized for this conversation");
    return "capability";
  }
  const tail = method === "POST" ? (headerValue(req, "x-content-sha256") ?? "") : "";
  if (await verifySignedRoute(ctx, tail)) return "source";
  req.resume();
  return null;
}

function blobStore(ctx: BaseCtx): NonNullable<BaseCtx["deps"]["blobTransfer"]> {
  if (ctx.deps.blobTransfer) return ctx.deps.blobTransfer;
  ctx.req.resume();
  throw fail(501, "not_configured", "no blob transfer store wired");
}

async function putBlob(ctx: BaseCtx): Promise<RouteResult> {
  const { req } = ctx;
  const store = blobStore(ctx);
  const declaredSha = headerValue(req, "x-content-sha256") ?? "";
  if (ctx.secret && !headerValue(req, CAPABILITY_HEADER) && !/^[0-9a-f]{64}$/.test(declaredSha)) {
    req.resume();
    return reply(400, { error: "bad_request", message: "x-content-sha256 (hex sha-256) required" });
  }
  const via = await authorizeBlob(ctx, "write", null);
  if (!via) return;
  if (via === "capability") extendBodyDeadline(req, STAGE_UPLOAD_DEADLINE_MS);
  try {
    const info = await store.put(req, {
      maxBytes: via === "capability" ? MAX_STAGE_BLOB_BYTES : MAX_BLOB_BYTES,
      ...(declaredSha ? { expectedSha256: declaredSha } : {}),
    });
    return ok({ blobId: info.blobId, sizeBytes: info.sizeBytes });
  } catch (e) {
    req.resume();
    if (e instanceof BlobTooLargeError) return reply(413, { error: "payload_too_large", message: e.message });
    if (e instanceof BlobHashMismatchError) return reply(400, { error: "hash_mismatch", message: e.message });
    throw e;
  }
}

async function getBlob(ctx: BaseCtx): Promise<RouteResult> {
  const { res, params } = ctx;
  const store = blobStore(ctx);
  if (!(await authorizeBlob(ctx, "read", params.id!))) return;
  const blob = await store.open(params.id!);
  if (!blob) return reply(404, { error: "not_found" });
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(blob.sizeBytes) });
  pipeToResponse(res, blob.stream, "blob read failed");
}

export const blobRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/blobs", actor: "system", auth: "either", handle: putBlob },
  { method: "GET", path: "/v1/blobs/:id", auth: "either", handle: getBlob },
];
