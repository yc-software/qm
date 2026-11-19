import { resolveReadChannel, type SurfaceContextQuery, type SurfaceContextResult } from "../../reach/reach.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { personAtKeyboard } from "../artifact-share.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { sleep } from "../../util/async.ts";
import { awaitContextOutcome, SURFACE_FILE_WAIT_MS } from "../surface-context-puller.ts";

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
    const r = await resolveReadChannel(app, cap.actorId, b.channel);
    if (!r.ok) {
      const { ok: _ok, status, ...body } = r;
      sendJson(res, status, body);
      return null;
    }
    return {
      source: "slack",
      target: { channelId: r.channelId, ...(r.channelName ? { channelName: r.channelName } : {}) },
    };
  }
  const dest = cap.destination;
  if (!dest?.target || !app.surfaceMirrored(dest.type)) {
    sendJson(res, 400, {
      error: "no_conversation",
      message: "this conversation has no surface history to pull — name a channel instead",
    });
    return null;
  }
  return { source: dest.type, target: { conversationTarget: dest.target } };
}

async function rateLimitRecipient(ctx: ApiCtx): Promise<Pick<SurfaceContextQuery, "rateLimitRecipient">> {
  const cap = ctx.capability;
  if (!cap?.liveActor || !personAtKeyboard(cap) || cap.destination?.type !== "slack" || !cap.destination.target)
    return {};
  const member = await ctx.app.directoryMember(cap.actorId);
  return { rateLimitRecipient: { target: cap.destination.target, user: member?.slackId ?? cap.actorId } };
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
    ...(await rateLimitRecipient(ctx)),
    ...(before ? { before } : {}),
    ...(match ? { match } : {}),
    ...(b.live === true ? { live: true } : {}),
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
    ...(await rateLimitRecipient(ctx)),
    file: { ts, ...(threadTs ? { threadTs } : {}), ...(name ? { name } : {}) },
  };
  const request = await app.createContextRequest(resolved.source, query);
  return awaitFileFulfillment(ctx, request.id);
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
function awaitFileFulfillment(ctx: ApiCtx, requestId: string): Promise<void> {
  return awaitOutcome(ctx, requestId, SURFACE_FILE_WAIT_MS, async (result) => {
    const { res, capability, secret } = ctx;
    const file = result.attachments?.[0];
    if (!file) {
      return sendJson(res, 502, {
        error: "surface_error",
        message:
          [...(result.issues ?? []), ...(result.note ? [result.note] : [])].join("; ") ||
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
      ctx.deps.capabilityTokenCompression,
    );
    const { blobId, name, sizeBytes, mimetype, author } = file;
    const meta = { name, sizeBytes, mimetype, ...(author ? { author } : {}) };
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
  const sent: unknown[] = Array.isArray(b.attachments) ? b.attachments : [];
  const readable = (a: unknown): a is { blobId: string; name: string; sizeBytes: number } & Record<string, unknown> =>
    isObj(a) && typeof a.blobId === "string" && typeof a.name === "string" && typeof a.sizeBytes === "number";
  const attachments = Array.isArray(b.attachments)
    ? sent.filter(readable).map((a) => ({
        blobId: a.blobId,
        name: a.name,
        sizeBytes: a.sizeBytes,
        mimetype: typeof a.mimetype === "string" ? a.mimetype : "application/octet-stream",
        ...(typeof a.sourceId === "string" ? { sourceId: a.sourceId } : {}),
        ...(typeof a.author === "string" ? { author: a.author } : {}),
      }))
    : undefined;
  const rejected = sent.filter((a) => !readable(a));
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
            ...(Array.isArray(b.selfTs) ? { selfTs: b.selfTs.filter((ts) => typeof ts === "string") } : {}),
            ...(b.liveSearch === "unconfigured" || b.liveSearch === "unconnected" ? { liveSearch: b.liveSearch } : {}),
            ...(attachments ? { attachments } : {}),
            ...(Array.isArray(b.issues) || rejected.length
              ? {
                  issues: [
                    ...(Array.isArray(b.issues) ? b.issues.filter((i) => typeof i === "string") : []),
                    ...rejected.map((a) => `the surface sent an unreadable attachment: ${JSON.stringify(a)}`),
                  ],
                }
              : {}),
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
  {
    method: "POST",
    path: "/v1/surface-context",
    actor: "system",
    auth: "either",
    allowedInStrict: true,
    handle: createSurfaceContextRequest,
  },
  { method: "POST", path: "/v1/surface-file", actor: "system", auth: "either", handle: createSurfaceFileRequest },
  { method: "GET", path: "/v1/surface-context/pending", auth: "source", handle: listPendingContextRequests },
  {
    method: "POST",
    path: "/v1/surface-context/:id/result",
    actor: "system",
    auth: "source",
    handle: fulfillContextRequest,
  },
];
