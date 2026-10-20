import { nativeSlackConfigured, nativeSlackConnection } from "./slack-native.ts";
import { composioSlackConnection, hasSlackAccount } from "./slack-composio.ts";
import { parseSlackThreadRef } from "../../slack/message-gating.ts";
import { sendJson } from "../http.ts";
import { reportFailure } from "../../util/errors.ts";
import { activePrincipal } from "./shared.ts";
import type { ApiCtx } from "./route.ts";

export async function slackReply(ctx: ApiCtx, send: boolean): Promise<void> {
  if (!ctx.actor || ctx.actor.imp || ctx.capability)
    return sendJson(ctx.res, 403, { error: "browser_identity_required" });
  ctx.res.setHeader("Cache-Control", "no-store");
  if (!(await activePrincipal(ctx.deps, ctx.actor.p))) return sendJson(ctx.res, 403, { error: "forbidden" });
  const body = ctx.body as { sessionId?: unknown; text?: unknown; clientMessageId?: unknown } | null;
  if (typeof body?.sessionId !== "string") return sendJson(ctx.res, 400, { error: "invalid_session" });
  const source = await ctx.app.getSessionForViewer(body.sessionId, ctx.actor.p);
  if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = parseSlackThreadRef(source.session.threadRef);
  if (!target || !/^[CDG][A-Z0-9]+$/.test(target.container) || (target.root && !/^\d+\.\d+$/.test(target.root)))
    return sendJson(ctx.res, 400, { error: "not_slack" });
  if (
    send &&
    (typeof body.text !== "string" ||
      !body.text.trim() ||
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
        webTranscript: { kind: "slack_reply", sessionId: body.sessionId as string, ts, name },
      },
      text: body.text as string,
      idempotencyKey: `slack-reply:${body.sessionId}:${target.container}:${ts}`,
    });
    return sendJson(ctx.res, 200, { sent: true, ts });
  };
  let attemptedSend = false;
  const replyVia = async (connection: {
    user?: string;
    workspace?: string;
    call: (
      method: string,
      payload?: Record<string, unknown>,
    ) => Promise<{ ok?: boolean; ts?: string; error?: string } | undefined>;
  }) => {
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
    if (!send)
      return sendJson(ctx.res, 200, { connected: true, user: connection.user, workspace: connection.workspace });
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
    if (native) return await replyVia(native);
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
