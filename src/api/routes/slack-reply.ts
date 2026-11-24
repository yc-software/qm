import { nativeSlackConfigured, nativeSlackConnection } from "./slack-native.ts";
import { composioSlackConnection, hasSlackAccount } from "./slack-composio.ts";
import { parseSlackThreadRef } from "../../slack/message-gating.ts";
import { sendJson } from "../http.ts";
import { reportFailure } from "../../util/errors.ts";
import { activePrincipal } from "./shared.ts";
import type { ApiCtx } from "./route.ts";

const MAX_SLACK_FILES = 10;
const BLOB_ID = /^[0-9a-f]{32}$/;

function slackFiles(raw: unknown): { name: string; blobId: string }[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SLACK_FILES) return null;
  const files = raw.map((f: { name?: unknown; blobId?: unknown }) =>
    typeof f?.name === "string" && f.name && typeof f.blobId === "string" && BLOB_ID.test(f.blobId)
      ? { name: f.name.slice(0, 255), blobId: f.blobId }
      : null,
  );
  return files.every(Boolean) ? (files as { name: string; blobId: string }[]) : null;
}

type SlackCall = (method: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

async function sharedTs(connection: { call: unknown }, fileId: string, channel: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const info = await (connection.call as SlackCall)("files.info", { file: fileId });
    const shares = (info?.file as { shares?: Record<string, Record<string, { ts?: string }[]>> } | undefined)?.shares;
    const ts = shares?.public?.[channel]?.[0]?.ts ?? shares?.private?.[channel]?.[0]?.ts;
    if (ts) return ts;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

export async function slackReply(ctx: ApiCtx, send: boolean): Promise<void> {
  if (!ctx.actor || ctx.actor.imp || ctx.capability)
    return sendJson(ctx.res, 403, { error: "browser_identity_required" });
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!(await activePrincipal(ctx.deps, ctx.actor.p))) return sendJson(ctx.res, 403, { error: "forbidden" });
  const body = ctx.body as {
    sessionId?: unknown;
    text?: unknown;
    clientMessageId?: unknown;
    attachments?: unknown;
  } | null;
  const files = slackFiles(body?.attachments);
  if (typeof body?.sessionId !== "string") return sendJson(ctx.res, 400, { error: "invalid_session" });
  const source = await ctx.app.getSessionForViewer(body.sessionId, { actorId: ctx.actor.p });
  if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = parseSlackThreadRef(source.session.threadRef);
  if (!target || !/^[CDG][A-Z0-9]+$/.test(target.container) || (target.root && !/^\d+\.\d+$/.test(target.root)))
    return sendJson(ctx.res, 400, { error: "not_slack" });
  if (
    send &&
    (typeof body.text !== "string" ||
      !files ||
      (!body.text.trim() && !files.length) ||
      body.text.length > 4000 ||
      typeof body.clientMessageId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientMessageId))
  )
    return sendJson(ctx.res, 400, { error: "invalid_message" });
  if (send && !ctx.deps.deliveries)
    return sendJson(ctx.res, 503, {
      error: "slack_unavailable",
      message: "Slack replies are temporarily unavailable.",
    });
  let slackConfirmed = false;
  const recordReply = async (ts: unknown, name: string) => {
    slackConfirmed = true;
    if (typeof ts !== "string" || !/^\d+\.\d+$/.test(ts)) throw new Error("Slack response missing timestamp");
    await ctx.deps.deliveries!.enqueue({
      destination: {
        type: "web",
        target: source.session.threadRef,
        audienceScopeId: source.session.scopeId,
        webTranscript: {
          kind: "slack_reply",
          sessionId: body.sessionId as string,
          ts,
          name,
          speakerId: ctx.actor!.p,
        },
      },
      text: body.text as string,
      idempotencyKey: `slack-reply:${body.sessionId}:${target.container}:${ts}`,
    });
    return sendJson(ctx.res, 200, { sent: true, ts });
  };
  let attemptedSend = false;
  const replyVia = async (connection: {
    native?: boolean;
    user?: string;
    workspace?: string;
    call: (
      method: string,
      payload?: Record<string, unknown>,
    ) => Promise<{ ok?: boolean; ts?: string; error?: string } | undefined>;
  }) => {
    if (!send)
      return sendJson(ctx.res, 200, { connected: true, user: connection.user, workspace: connection.workspace });
    const conversation = await connection.call("conversations.info", { channel: target.container });
    if (!conversation?.ok) {
      reportFailure(
        "slack reply: conversation access",
        new Error(conversation?.error ?? "Slack rejected conversation access"),
        `session=${body.sessionId}`,
      );
      return sendJson(ctx.res, 403, {
        error: "slack_access_denied",
        message: "Your Slack account cannot access this conversation. Check its Slack permissions.",
      });
    }
    if (files?.length) {
      if (!connection.native)
        return sendJson(ctx.res, 409, {
          error: "slack_files_unsupported",
          message: "Reconnect Slack to attach files.",
        });
      const uploads = [];
      for (const file of files) {
        const blob = await ctx.deps.blobTransfer?.open(file.blobId);
        if (!blob) return sendJson(ctx.res, 400, { error: "invalid_attachment" });
        const bytes = Buffer.concat(await blob.stream.toArray());
        const slot = (await connection.call("files.getUploadURLExternal", {
          filename: file.name,
          length: bytes.length,
        })) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string } | undefined;
        if (slot?.error === "missing_scope")
          return sendJson(ctx.res, 409, { error: "slack_files_scope", message: "Reconnect Slack to attach files." });
        if (!slot?.ok || !slot.upload_url || !slot.file_id) throw new Error(slot?.error ?? "Slack upload slot failed");
        const put = await fetch(slot.upload_url, { method: "POST", body: bytes });
        if (!put.ok) throw new Error(`Slack upload failed: HTTP ${put.status}`);
        uploads.push({ id: slot.file_id, title: file.name });
      }
      attemptedSend = true;
      const done = await connection.call("files.completeUploadExternal", {
        files: JSON.stringify(uploads),
        channel_id: target.container,
        ...(target.root ? { thread_ts: target.root } : {}),
        ...((body.text as string).trim() ? { initial_comment: body.text } : {}),
      });
      if (!done?.ok) throw new Error(done?.error ?? "Slack rejected file share");
      const ts = await sharedTs(connection, uploads[0]!.id, target.container);
      if (!ts)
        reportFailure(
          "slack reply: file share timestamp",
          new Error(`files.info showed no share of ${uploads[0]!.id} in ${target.container}`),
          `session=${body.sessionId}`,
        );
      return recordReply(ts, connection.user ?? ctx.actor!.p);
    }
    attemptedSend = true;
    const result = await connection.call("chat.postMessage", {
      channel: target.container,
      ...(target.root ? { thread_ts: target.root } : {}),
      text: body.text,
      client_msg_id: body.clientMessageId,
      as_user: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result?.ok) {
      reportFailure(
        "slack reply: send",
        new Error(result?.error ?? "Slack rejected message send"),
        `session=${body.sessionId}`,
      );
      return sendJson(ctx.res, 403, {
        error: "slack_send_failed",
        message:
          "Slack could not send your message. Check your account’s conversation access and permission to send messages.",
      });
    }
    return recordReply(result.ts, connection.user ?? ctx.actor!.p);
  };
  try {
    const native = await nativeSlackConnection(ctx);
    if (native) return await replyVia({ ...native, native: true });
    const hasComposioLink = await hasSlackAccount(ctx);
    if (!hasComposioLink && (await nativeSlackConfigured(ctx)))
      return sendJson(ctx.res, send ? 409 : 200, {
        connected: false,
        error: "slack_link_required",
        message: "Link your personal Slack account to reply.",
      });
    const connection = await composioSlackConnection(ctx);
    if (connection === undefined) return;
    if (connection) return await replyVia(connection);
    return sendJson(ctx.res, send ? 409 : 200, {
      connected: false,
      error: "slack_link_required",
      message: "Link your personal Slack account to reply.",
    });
  } catch (error) {
    reportFailure("slack reply", error, `session=${body.sessionId}`);
    if (slackConfirmed)
      return sendJson(ctx.res, 502, {
        error: "transcript_unavailable",
        message: "Slack sent your message, but its transcript update could not be saved. Do not resend it.",
      });
    return sendJson(ctx.res, 502, {
      error: "slack_unavailable",
      message: attemptedSend
        ? "The send outcome is unknown. Check Slack before trying again."
        : "Could not verify your Slack connection. Please try again.",
    });
  }
}
