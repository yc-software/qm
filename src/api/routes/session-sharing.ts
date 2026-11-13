import { collectBytes } from "../../util/bytes.ts";
import { randomUUID } from "node:crypto";
import {
  sharedMessages,
  type SessionShare,
  type SharedAttachment,
  type SharedMessage,
} from "../../sessions/session-share.ts";
import { MAX_ATTACHMENT_BYTES } from "../../core/attachments.ts";
import { sendJson } from "../http.ts";
import { relayStream } from "../../../plugins/chassis/src/http.ts";
import { audit, isObj } from "./shared.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";

async function createShare(ctx: ApiCtx): Promise<void> {
  const { deps, app, res, body, params } = ctx;
  res.setHeader("Cache-Control", "no-store");
  const viewer = ctx.actor?.p ?? (isObj(body) && body.principalId);
  const audience = isObj(body) ? body.audience : undefined;
  if (audience !== "internal" && audience !== "external") return sendJson(res, 400, { error: "invalid_audience" });
  await deps.identity?.refresh();
  if (typeof viewer !== "string" || !deps.identity?.isInternal(deps.identity.classify(viewer)))
    return sendJson(res, 403, { error: "forbidden" });
  if (!deps.sessionShares || !deps.sessionShareBytes) return sendJson(res, 503, { error: "sharing_unavailable" });
  const source = await app.getSessionForViewer(params.id!, { actorId: viewer });
  if (!source) return sendJson(res, 404, { error: "not_found" });
  const deliveries =
    (await deps.deliveries?.listBySourceSession(source.session.id, source.session.threadRef, { limit: 10_000 })) ?? [];
  if (deliveries.length >= 10_000) return sendJson(res, 413, { error: "share_too_large" });
  const deliveredAttachments = new Map<number, string[]>();
  for (const delivery of deliveries) {
    const seq = delivery.provenance?.sourceAssistantEntrySeq;
    if (
      delivery.deliveredAt === null ||
      delivery.shadow ||
      delivery.destination.type !== "web" ||
      delivery.destination.target !== source.session.threadRef ||
      delivery.provenance?.sourceSessionId !== source.session.id ||
      seq === undefined
    )
      continue;
    const ids = (delivery.attachments ?? []).flatMap((file) => (file.artifactId ? [file.artifactId] : []));
    deliveredAttachments.set(seq, [...(deliveredAttachments.get(seq) ?? []), ...ids]);
  }
  const projected = sharedMessages(source.items, deliveredAttachments);
  if (!projected.length) return sendJson(res, 400, { error: "empty_conversation" });
  const ids = [...new Set(projected.flatMap((m) => m.attachmentIds ?? []))];
  if (ids.length > 100 || Buffer.byteLength(JSON.stringify(projected)) > 2_000_000)
    return sendJson(res, 413, { error: "share_too_large" });
  const files: SessionShare["files"] = [];
  const attachments = new Map<string, SharedAttachment>();
  const pending: Array<{ sourceId: string; name: string; mimetype: string; data: Buffer }> = [];
  let totalBytes = 0;
  for (const id of ids) {
    const file = await app.openFileForViewer(tenantOf(ctx), id, viewer);
    if (!file)
      return sendJson(res, 409, {
        error: "attachment_unavailable",
        message: "An attachment is no longer available to share.",
      });
    const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024 - totalBytes);
    if (file.sizeBytes > maxBytes) {
      file.stream.destroy();
      return sendJson(res, 413, { error: "attachments_too_large" });
    }
    try {
      const collected = await collectBytes(file.stream, { maxBytes });
      totalBytes += collected.sizeBytes;
      pending.push({ sourceId: id, name: file.name, mimetype: file.mimetype, data: collected.data });
    } catch {
      file.stream.destroy();
      return sendJson(res, 409, { error: "attachment_unavailable", message: "An attachment could not be copied." });
    }
  }
  for (const file of pending) {
    const stored = await deps.sessionShareBytes.put(file.data, { maxBytes: MAX_ATTACHMENT_BYTES });
    const attachment = { id: randomUUID(), name: file.name, mimetype: file.mimetype, sizeBytes: stored.sizeBytes };
    attachments.set(file.sourceId, attachment);
    files.push({ ...attachment, blobKey: stored.blobKey });
  }
  const messages: SharedMessage[] = projected.map(({ role, text, attachmentIds }) => ({
    role,
    text,
    ...(attachmentIds?.length ? { attachments: attachmentIds.map((id) => attachments.get(id)!) } : {}),
  }));
  const share: SessionShare = {
    token: randomUUID(),
    sessionId: params.id!,
    audience,
    createdBy: viewer,
    createdAt: Date.now(),
    messages,
    files,
  };
  await deps.sessionShares.putIfAbsent(share.token, share);
  audit(ctx, {
    principalId: viewer,
    action: "session.share",
    resource: share.sessionId,
    scopeLabel: source.session.scopeId,
    detail: audience,
  });
  return sendJson(res, 200, { share: { token: share.token, audience, createdAt: share.createdAt } });
}

async function openShare(ctx: ApiCtx, external: boolean): Promise<SessionShare | 403 | 404> {
  const { deps, app, params, url } = ctx;
  const share = await deps.sessionShares?.get(params.token!);
  if (!share || share.audience !== (external ? "external" : "internal")) return 404;
  await deps.identity?.refresh();
  if (!external) {
    const viewer = ctx.actor?.p ?? url.searchParams.get("viewer");
    if (!viewer || !deps.identity?.isInternal(deps.identity.classify(viewer))) return 403;
  }
  if (!deps.identity?.isInternal(deps.identity.classify(share.createdBy))) return 404;
  if (!(await app.canViewSessionSnapshot(share.sessionId, share.createdBy))) return 404;
  return share;
}

const transcriptOf = (share: SessionShare) => ({
  createdAt: share.createdAt,
  audience: share.audience,
  messages: share.messages,
});

async function sharePage(ctx: ApiCtx, external: boolean): Promise<void> {
  const shell = ctx.deps.web?.shell;
  if (!shell) return sendJson(ctx.res, 404, { error: "not_found" });
  const share = await openShare(ctx, external);
  if (typeof share === "number") return shell.sharePage(ctx.res, share, null);
  return shell.sharePage(ctx.res, 200, transcriptOf(share));
}

async function readShare(ctx: ApiCtx): Promise<void> {
  const { res, params, url } = ctx;
  res.setHeader("Cache-Control", "no-store");
  const share = await openShare(ctx, ctx.pathname.startsWith("/v1/public-shares/"));
  if (share === 403) return sendJson(res, 403, { error: "forbidden" });
  if (share === 404) return sendJson(res, 404, { error: "not_found" });
  if (params.fileId) {
    const file = share.files.find((file) => file.id === params.fileId);
    const opened = file && (await ctx.deps.sessionShareBytes?.open(file.blobKey));
    if (!file || !opened) return sendJson(res, 404, { error: "not_found" });
    const inline = url.searchParams.get("inline") === "1" && /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimetype);
    res.writeHead(200, {
      "content-type": inline ? file.mimetype : "application/octet-stream",
      "content-length": String(opened.sizeBytes),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    relayStream(opened.stream, res);
    return;
  }
  return sendJson(res, 200, transcriptOf(share));
}

const SHARE_TENANT = { by: "share", key: (params: Record<string, string>) => params.token } as const;
const BROWSER_SHARE_TENANT = { ...SHARE_TENANT, signedTenantFirst: true } as const;

export const sessionSharingRoutes: ReadonlyArray<Route> = [
  {
    method: "POST",
    path: "/v1/sessions/:id/share",
    browser: true,
    actor: "body.principalId",
    auth: "source",
    handle: createShare,
  },
  ...(["shared-sessions", "public-shares"] as const).flatMap((prefix): Route[] => {
    const shared = prefix === "shared-sessions";
    const actor = shared ? ("query.viewer" as const) : undefined;
    const tenant = SHARE_TENANT;
    return [
      { method: "GET", path: `/v1/${prefix}/:token`, actor, auth: "source", tenant, handle: readShare },
      {
        method: "GET",
        path: `/v1/${prefix}/:token/files/:fileId`,
        ...(shared ? { browser: true as const } : {}),
        actor,
        auth: shared ? "source" : "public",
        tenant: shared ? BROWSER_SHARE_TENANT : tenant,
        handle: readShare,
      },
    ];
  }),
  {
    method: "GET",
    path: "/v1/web/shares/internal/:token",
    browser: true,
    actor: "person",
    auth: "source",
    tenant: BROWSER_SHARE_TENANT,
    handle: (ctx) => sharePage(ctx, false),
  },
  {
    method: "GET",
    path: "/v1/web/shares/external/:token",
    auth: "public",
    tenant: SHARE_TENANT,
    handle: (ctx) => sharePage(ctx, true),
  },
];
