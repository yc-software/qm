import type { SurfaceTransport } from "../surfaces/turn-driver.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { attachmentList, logAttachmentFailure } from "../surfaces/attachments.ts";
import {
  type PostMessageArgs,
  batchPostMessageArgs,
  botIdentityArgs,
  plainContext,
  postWithVerify,
  resolveReactionTargets,
  slackPersonaReplyArgs,
  slackReplyArgs,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
} from "./lib.ts";
import { applyAndLogReactions, cleanAgentReplyForSlack, updateSlackMessage } from "./messaging.ts";
import { escapeSlackText } from "./mrkdwn.ts";
import type { SlackThinkingStream } from "./thinking-stream.ts";
import type { StepDetailMode } from "./step-labels.ts";

const noticeBlocks = (text: string): Array<Record<string, unknown>> => [
  { type: "context", elements: [{ type: "mrkdwn", text }] },
];

export function createSlackTurnTransport(at: {
  client: any;
  blobs: Parameters<typeof uploadAttachments>[4];
  kind: "dm" | "channel";
  channel: string;
  userId: string | undefined;
  triggerTs: string;
  threadTs: string | undefined;
  reactable(): ReadonlySet<string>;
  webUiPublicUrl?: string;
  thinkingStream?: SlackThinkingStream;
  sessionId?: () => string;
  detailMode?: () => StepDetailMode;
  recipientTeamId?: string;
  unprompted?: boolean;
  initialTitle?: string;
  onEngaged?: (
    runId: string,
    channel: string,
    threadTs?: string,
    meta?: {
      sessionId: string;
      detailMode: StepDetailMode;
      recipientUserId?: string;
      recipientTeamId?: string;
      unprompted?: boolean;
      initialTitle?: string;
    },
  ) => void;
  onSettled?: (runId?: string) => void;
}): SurfaceTransport {
  const { client, channel, threadTs } = at;
  const notices = new Set<string>();
  let activeRunId: string | undefined;

  const post: SurfaceTransport["post"] = async (msg, opts = {}) => {
    if (activeRunId && at.thinkingStream && !opts.notice && threadTs) {
      const streamed = await at.thinkingStream.deliver(client, {
        runId: activeRunId,
        channel,
        threadTs,
        rawMarkdown: opts.rawMarkdown ?? msg,
        mrkdwnFallback: msg,
        ...(opts.note ? { footerBlocks: [plainContext(opts.note)] } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        unfurlLinks: false,
        finalize: true,
      });
      if (streamed.handled) return streamed.messageTs;
    }
    const baseOpts = { threadOnly: at.kind === "channel", unfurlLinks: false, persona: opts.persona };
    const args: PostMessageArgs = opts.notice
      ? { ...slackReplyArgs(channel, msg, threadTs, baseOpts), blocks: noticeBlocks(msg) }
      : slackPersonaReplyArgs(channel, msg, threadTs, {
          ...baseOpts,
          webUiPublicUrl: at.webUiPublicUrl,
          ...(opts.note ? { footer: [plainContext(opts.note)] } : {}),
        });
    if (opts.idempotencyKey) return (await postWithVerify(client, args, opts.idempotencyKey)).ts;
    let firstTs: string | undefined;
    for (const [i, batch] of batchPostMessageArgs(args).entries()) {
      const ts = (await client.chat.postMessage(batch)).ts as string | undefined;
      if (i === 0) firstTs = ts;
    }
    if (opts.notice && firstTs) notices.add(firstTs);
    return firstTs;
  };

  return {
    post,
    async postPrivate(msg, opts) {
      if (activeRunId && at.thinkingStream && (await at.thinkingStream.hasOpenStream(activeRunId))) {
        const outcome = opts?.outcome ?? "failed";
        if (at.kind === "dm" && !opts?.transient) {
          const handled = await at.thinkingStream.finishRun(client, activeRunId, { outcome, note: msg });
          if (handled) return;
        } else {
          await at.thinkingStream.finishRun(client, activeRunId, { outcome });
        }
      }
      if (at.kind === "dm" && !opts?.transient) {
        await post(msg);
        return;
      }
      await client.chat
        .postEphemeral({
          channel,
          user: at.userId,
          text: msg,
          ...(opts?.transient && threadTs ? { thread_ts: threadTs } : {}),
        })
        .catch(swallowAs("slack: chat.postEphemeral", undefined));
    },
    async edit(ref, text) {
      if (!notices.has(ref)) await updateSlackMessage(client, channel, ref, text);
      else await client.chat.update({ channel, ts: ref, text, blocks: noticeBlocks(text), ...botIdentityArgs() });
    },
    remove: (ref) => client.chat.delete({ channel, ts: ref }).then(() => {}),
    react: (ref, name, on) => client.reactions[on ? "add" : "remove"]({ channel, timestamp: ref, name }).then(() => {}),
    async applyReactions(reactions) {
      const { directives, dropped } = resolveReactionTargets(reactions, at.reactable());
      if (dropped) console.error(`[slack-plugin] dropped ${dropped} reaction(s) with an unresolvable message id`);
      await applyAndLogReactions(client, channel, at.triggerTs, directives);
    },
    async typing(on, run) {
      if (!on) {
        at.onSettled?.(activeRunId);
        return;
      }
      if (run) {
        activeRunId = run.runId;
        if (threadTs) {
          at.onEngaged?.(run.runId, channel, threadTs, {
            sessionId: at.sessionId?.() ?? `${channel}:${threadTs}`,
            detailMode: at.detailMode?.() ?? "full",
            ...(at.userId ? { recipientUserId: at.userId } : {}),
            ...(at.recipientTeamId ? { recipientTeamId: at.recipientTeamId } : {}),
            ...(at.unprompted ? { unprompted: true } : {}),
            ...(at.initialTitle ? { initialTitle: at.initialTitle } : {}),
          });
        }
      }
    },
    async finishTurn(runId, outcome) {
      await at.thinkingStream?.finishRun(client, runId, { outcome });
    },
    async upload(attachments) {
      try {
        await uploadAttachments(client, channel, threadTs, attachments, at.blobs);
        return {};
      } catch (err) {
        logAttachmentFailure(
          "upload failed",
          { surface: "slack-plugin", chat: channel },
          `files=${attachmentList(attachments)} reason=${errMessage(err)}`,
        );
        return { failureNote: uploadFailureNote(err) };
      }
    },
    render: toSlackMrkdwn,
    escape: escapeSlackText,
    readReply: cleanAgentReplyForSlack,
  };
}
