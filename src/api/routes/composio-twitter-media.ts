import { ACCOUNT_ID, activeRun, composioUserIds, credential, ownedAccount, request } from "./composio.ts";
import { sendJson } from "../http.ts";
import { sniffImageDimensions } from "../../core/image-downscale.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 2 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const X_MEDIA_UPLOAD = "https://api.x.com/2/media/upload";

class XMediaError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  constructor(endpoint: string, status: number, response: unknown) {
    super(`X ${endpoint} returned status ${status}: ${JSON.stringify(response)?.slice(0, 1000)}`);
    this.status = status;
    const { detail, errors } = (response ?? {}) as { detail?: unknown; errors?: unknown };
    const messages = [
      detail,
      ...(Array.isArray(errors) ? errors.map((e) => (e as { message?: unknown })?.message) : []),
    ];
    this.detail = messages.filter((m): m is string => typeof m === "string").join(" ") || undefined;
  }
}

async function xMedia(
  ctx: ApiCtx,
  key: string,
  accountId: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await request(
    ctx,
    key,
    "/tools/execute/proxy",
    { connected_account_id: accountId, endpoint, method: "POST", ...(body ? { body } : {}) },
    UPLOAD_TIMEOUT_MS,
  );
  const status = typeof result.status === "number" ? result.status : 0;
  if (status < 200 || status >= 300) throw new XMediaError(endpoint, status, result.data);
  const data = (result.data as { data?: unknown } | undefined)?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

async function uploadMedia(ctx: ApiCtx): Promise<void> {
  if (!ctx.capability || ctx.actor) return sendJson(ctx.res, 403, { error: "agent_capability_required" });
  const access = await credential(ctx);
  if (!access) return;
  const body = ctx.body as Record<string, unknown> | null;
  if (
    !body ||
    Object.keys(body).some((key) => key !== "accountId" && key !== "data") ||
    typeof body.accountId !== "string" ||
    !ACCOUNT_ID.test(body.accountId) ||
    typeof body.data !== "string" ||
    !body.data
  )
    return sendJson(ctx.res, 400, {
      error: "invalid_upload",
      message: "Supply accountId and the image as base64 data only.",
    });
  if (body.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    return sendJson(ctx.res, 413, { error: "media_too_large", message: "Images must be 5 MB or smaller." });
  const bytes = Buffer.from(body.data, "base64");
  if (bytes.toString("base64") !== body.data)
    return sendJson(ctx.res, 400, { error: "invalid_upload", message: "data must be standard padded base64." });
  if (bytes.length > MAX_IMAGE_BYTES)
    return sendJson(ctx.res, 413, { error: "media_too_large", message: "Images must be 5 MB or smaller." });
  const format = sniffImageDimensions(bytes)?.format;
  if (!format || format === "gif")
    return sendJson(ctx.res, 415, { error: "unsupported_media", message: "Upload a PNG, JPEG, or WebP image." });
  const mediaType = `image/${format}`;
  const accountId = body.accountId;
  const resource = `${accountId}/media`;
  const mask = createExactSecretValueMasker([access.key]);
  try {
    const owned = await ownedAccount(ctx, access, accountId);
    if (
      !owned ||
      owned.toolkit !== "twitter" ||
      owned.account.status !== "ACTIVE" ||
      owned.account.is_disabled === true
    )
      return sendJson(ctx.res, 403, { error: "connection_not_authorized" });
    if (!(await activeRun(ctx))) return;
    if (!composioUserIds(access.principal).includes(String(owned.account.user_id)))
      return sendJson(ctx.res, 403, { error: "connection_not_authorized" });
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.twitter_media.started",
      resource,
      scopeLabel: ctx.capability.scopeId,
    });
    const started = await xMedia(ctx, access.key, accountId, `${X_MEDIA_UPLOAD}/initialize`, {
      media_type: mediaType,
      total_bytes: bytes.length,
      media_category: "tweet_image",
    });
    const mediaId = started.id;
    if (typeof mediaId !== "string" || !/^\d{1,32}$/.test(mediaId)) throw new Error("Invalid media id");
    for (let offset = 0, segment = 0; offset < bytes.length; offset += CHUNK_BYTES, segment++) {
      if (!(await activeRun(ctx))) return;
      await xMedia(ctx, access.key, accountId, `${X_MEDIA_UPLOAD}/${mediaId}/append`, {
        media: bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
        segment_index: segment,
      });
    }
    if (!(await activeRun(ctx))) return;
    const finished = await xMedia(ctx, access.key, accountId, `${X_MEDIA_UPLOAD}/${mediaId}/finalize`);
    if (finished.id !== mediaId) throw new Error("Media id changed during upload");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.twitter_media.completed",
      resource: `${resource}/${mediaId}`,
      scopeLabel: ctx.capability.scopeId,
    });
    return sendJson(ctx.res, 200, {
      mediaId,
      mediaType,
      bytes: bytes.length,
      expiresAfterSecs: typeof finished.expires_after_secs === "number" ? finished.expires_after_secs : null,
    });
  } catch (error) {
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.twitter_media.failed",
      resource,
      scopeLabel: ctx.capability.scopeId,
    });
    reportFailure("composio: twitter media", new Error(mask(redactSecrets(errMessage(error)))), resource);
    const status = error instanceof XMediaError ? error.status : undefined;
    const detail = error instanceof XMediaError && error.detail ? mask(redactSecrets(error.detail)).slice(0, 300) : "";
    return sendJson(ctx.res, 502, {
      error: "media_upload_failed",
      ...(status ? { providerStatus: status } : {}),
      ...(detail ? { providerDetail: detail } : {}),
      message:
        status === 401 || status === 403
          ? "X refused the upload. The connection may lack media permission; reconnect X, then try again."
          : "The upload failed. Retrying is safe: unattached media posts nothing and expires within a day.",
    });
  }
}

export const composioTwitterMediaRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/composio/twitter/media",
    auth: "either",
    maxBodyBytes: 7_200_000,
    handle: uploadMedia,
  },
];
