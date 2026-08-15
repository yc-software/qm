import type { SurfaceContextQuery, SurfaceContextResult } from "../../types.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { sleep } from "../../util/async.ts";
import { awaitContextOutcome } from "../surface-context-puller.ts";

const SURFACE_CONTEXT_MAX_MESSAGES = 200;
const SURFACE_CONTEXT_DEFAULT_MESSAGES = 100;
const FULFILL_WAIT_MS = 25_000;
const FULFILL_POLL_MS = 100;
const PENDING_WAIT_CAP_MS = 20_000;
const PENDING_POLL_MS = 100;

async function resolveSurfaceTarget(
  ctx: ApiCtx,
  b: Record<string, unknown>,
): Promise<{
  source: string;
  target: Pick<SurfaceContextQuery, "channelId" | "channelName" | "conversationTarget">;
} | null> {
  const { res, app, capability } = ctx;
  const cap = capability!;
  if (typeof b.channel === "string" && b.channel.trim()) {
    const ref = b.channel.trim().replace(/^#/, "");
    if (/^[CG][A-Z0-9]{6,}$/.test(ref)) {
      if (!(await app.channelVisibleTo(cap.actorId, ref))) {
        await notVisible(ctx, cap.actorId, b.channel);
        return null;
      }
      return { source: "slack", target: { channelId: ref } };
    }
    const r = await app.resolveChannel(ref);
    if (r.kind === "none") {
      sendJson(res, 404, { error: "channel_not_found", message: `no channel I'm in matches "${b.channel}"` });
      return null;
    }
    if (r.kind === "ambiguous") {
      sendJson(res, 409, {
        error: "ambiguous_channel",
        message: `"${b.channel}" matches multiple channels — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ channelId: c.channelId, name: c.name })),
      });
      return null;
    }
    if (!(await app.channelVisibleTo(cap.actorId, r.channel.channelId, r.channel.isPrivate === true))) {
      await notVisible(ctx, cap.actorId, `#${r.channel.name}`);
      return null;
    }
    return { source: "slack", target: { channelId: r.channel.channelId, channelName: r.channel.name } };
  }
  const dest = cap.destination;
  if (!dest?.target || dest.type !== "slack") {
    sendJson(res, 400, {
      error: "no_conversation",
      message: "this conversation has no surface history to pull — name a channel instead",
    });
    return null;
  }
  return { source: dest.type, target: { conversationTarget: dest.target } };
}

async function createSurfaceContextRequest(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  const count = Math.max(
    1,
    Math.min(
      SURFACE_CONTEXT_MAX_MESSAGES,
      typeof b.count === "number" ? Math.floor(b.count) : SURFACE_CONTEXT_DEFAULT_MESSAGES,
    ),
  );
  const before = typeof b.before === "string" && b.before.trim() ? b.before.trim() : undefined;
  const match = typeof b.match === "string" && b.match.trim() ? b.match.trim().slice(0, 200) : undefined;

  const resolved = await resolveSurfaceTarget(ctx, b);
  if (!resolved) return;
  const query: SurfaceContextQuery = {
    ...resolved.target,
    viewer: capability.actorId,
    count,
    ...(before ? { before } : {}),
    ...(match ? { match } : {}),
  };
  const request = await app.createContextRequest(resolved.source, query);
  return awaitFulfillment(ctx, request.id, query.channelName);
}

async function createSurfaceFileRequest(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  const ts = typeof b.ts === "string" && b.ts.trim() ? b.ts.trim() : undefined;
  if (!ts) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "pass the message's `ts` (find it via /v1/surface-context)",
    });
  }
  const threadTs = typeof b.threadTs === "string" && b.threadTs.trim() ? b.threadTs.trim() : undefined;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;

  const resolved = await resolveSurfaceTarget(ctx, b);
  if (!resolved) return;
  const query: SurfaceContextQuery = {
    ...resolved.target,
    count: 1,
    file: { ts, ...(threadTs ? { threadTs } : {}), ...(name ? { name } : {}) },
  };
  const request = await app.createContextRequest(resolved.source, query);
  return awaitFileFulfillment(ctx, request.id);
}

async function notVisible(ctx: ApiCtx, actorId: string, label: string): Promise<void> {
  const known = await ctx.app.directoryMember(actorId);
  return sendJson(ctx.res, 403, {
    error: known ? "not_visible" : "identity_unverified",
    message: known
      ? `I can only read a private channel you're in, and I can't confirm you're in ${label}.`
      : `I can't confirm your identity in this workspace — your login may not be linked to Slack — so I can't check whether you're in ${label}. Connecting / signing in with Slack should fix it.`,
  });
}

async function awaitOutcome(
  ctx: ApiCtx,
  requestId: string,
  waitMs: number,
  onDone: (result: SurfaceContextResult) => void | Promise<void>,
): Promise<void> {
  const { res, app } = ctx;
  const outcome = await awaitContextOutcome(app, requestId, { waitMs, pollMs: FULFILL_POLL_MS });
  if (outcome.status === "done") return onDone(outcome.result);
  if (outcome.status === "failed") {
    return sendJson(res, 502, { error: "surface_error", message: outcome.error ?? "the surface couldn't answer that" });
  }
  return sendJson(res, 504, { error: "surface_timeout", message: "the surface didn't answer in time — try again" });
}

function awaitFulfillment(ctx: ApiCtx, requestId: string, channelName: string | undefined): Promise<void> {
  return awaitOutcome(ctx, requestId, FULFILL_WAIT_MS, (result) => {
    sendJson(ctx.res, 200, { ...(channelName ? { channel: `#${channelName}` } : {}), ...result });
  });
}

const FILE_DOWNLOAD_TTL_MS = 5 * 60_000;
const FILE_FULFILL_WAIT_MS = 120_000;
function awaitFileFulfillment(ctx: ApiCtx, requestId: string): Promise<void> {
  return awaitOutcome(ctx, requestId, FILE_FULFILL_WAIT_MS, async (result) => {
    const { res, capability, secret } = ctx;
    const file = result.file;
    if (!file) {
      return sendJson(res, 502, {
        error: "surface_error",
        message:
          "the surface can't fetch files yet (it may be mid-deploy) — tell the person plainly rather than retrying",
      });
    }
    const cap = capability!;
    const token = await mintCapabilityToken(
      {
        actorId: cap.actorId,
        scopeId: cap.scopeId,
        ...(cap.scopeVersion ? { scopeVersion: cap.scopeVersion } : {}),
        ...(cap.botActor ? { botActor: true } : {}),
        ...(cap.liveActor ? { liveActor: true } : {}),
        ...(cap.members ? { members: cap.members } : {}),
        aud: BLOB_TRANSFER_AUD,
        blob: { dir: "read", id: file.blobId },
        exp: Date.now() + FILE_DOWNLOAD_TTL_MS,
      },
      (ctx.deps.capabilitySecret ?? secret)!,
    );
    const { blobId, ...meta } = file;
    return sendJson(res, 200, {
      file: meta,
      download: {
        path: `/v1/blobs/${encodeURIComponent(blobId)}`,
        header: CAPABILITY_HEADER,
        token,
        expiresInSeconds: Math.floor(FILE_DOWNLOAD_TTL_MS / 1000),
      },
      note: `run: curl -fsS -H "${CAPABILITY_HEADER}: <token>" "$AGENT_API_URL/v1/blobs/${encodeURIComponent(blobId)}" -o <path you choose — do NOT paste the posted filename into a shell unquoted>`,
    });
  });
}

async function listPendingContextRequests(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const source = url.searchParams.get("source") ?? "slack";
  const waitMs = Math.max(0, Math.min(PENDING_WAIT_CAP_MS, Number(url.searchParams.get("waitMs")) || 0));
  const deadline = Date.now() + waitMs;
  let requests = await app.pendingContextRequests(source);
  while (!requests.length && Date.now() < deadline) {
    await sleep(PENDING_POLL_MS);
    requests = await app.pendingContextRequests(source);
  }
  return sendJson(res, 200, { requests: requests.map((r) => ({ id: r.id, query: r.query })) });
}

async function fulfillContextRequest(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const b = isObj(body) ? body : {};
  const f = isObj(b.file) ? b.file : undefined;
  const file =
    f && typeof f.blobId === "string" && typeof f.name === "string" && typeof f.sizeBytes === "number"
      ? {
          blobId: f.blobId,
          name: f.name,
          sizeBytes: f.sizeBytes,
          ...(typeof f.mimetype === "string" ? { mimetype: f.mimetype } : {}),
          ...(typeof f.author === "string" ? { author: f.author } : {}),
        }
      : undefined;
  const g = isObj(b.group) ? b.group : undefined;
  const group = g && typeof g.groupId === "string" && g.groupId ? { groupId: g.groupId } : undefined;
  const outcome =
    typeof b.error === "string"
      ? { error: b.error }
      : {
          result: {
            messages: Array.isArray(b.messages) ? b.messages : [],
            ...(typeof b.hasMore === "boolean" ? { hasMore: b.hasMore } : {}),
            ...(typeof b.nextBefore === "string" ? { nextBefore: b.nextBefore } : {}),
            ...(typeof b.note === "string" ? { note: b.note } : {}),
            ...(file ? { file } : {}),
            ...(group ? { group } : {}),
          } satisfies SurfaceContextResult,
        };
  const ok = await app.fulfillContextRequest(id, outcome);
  return sendJson(
    res,
    ok ? 200 : 404,
    ok ? { ok: true } : { error: "not_found", message: "request expired or already answered" },
  );
}

export const contextRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/surface-context", auth: "either", handle: createSurfaceContextRequest },
  { method: "POST", path: "/v1/surface-file", auth: "either", handle: createSurfaceFileRequest },
  { method: "GET", path: "/v1/surface-context/pending", auth: "source", handle: listPendingContextRequests },
  { method: "POST", path: "/v1/surface-context/:id/result", auth: "source", handle: fulfillContextRequest },
];
