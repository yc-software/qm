import { type IncomingMessage, type ServerResponse } from "node:http";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { json, sendBuffered } from "../../chassis/src/http.ts";

import { CORE_API_URL as CORE, coreSigningSecret } from "../../chassis/src/env.ts";

import { type WebCtx } from "./core-relay.ts";

async function stageUploadStream(req: IncomingMessage, sha256: string): Promise<Response> {
  const corePath = withSourceAuthNonce("/v1/blobs", coreSigningSecret());
  const headers = {
    ...signedHeaders(coreSigningSecret(), "POST", corePath, "", sha256),
    "content-type": "application/octet-stream",
    "x-content-sha256": sha256,
  };
  return fetch(`${CORE}${corePath}`, {
    method: "POST",
    headers,
    body: req as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export async function stageFromRequest(c: WebCtx): Promise<{ staged: Response; text: string } | null> {
  const sha256 = c.url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    c.req.resume();
    json(c.res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
    return null;
  }
  const staged = await stageUploadStream(c.req, sha256);
  return { staged, text: await staged.text() };
}

export function sendStaged(res: ServerResponse, { staged, text }: { staged: Response; text: string }): void {
  sendBuffered(res, staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" }, text);
}

export async function stagedFile(c: WebCtx): Promise<{ name: string; mimetype: string; blobId: string } | null> {
  const upload = await stageFromRequest(c);
  if (!upload) return null;
  if (!upload.staged.ok) return (sendStaged(c.res, upload), null);
  const contentType = c.req.headers["content-type"];
  return {
    name: c.url.searchParams.get("name")?.trim() || "file",
    mimetype: typeof contentType === "string" ? contentType : "application/octet-stream",
    blobId: (JSON.parse(upload.text) as { blobId: string }).blobId,
  };
}
