import type { SurfaceTransport } from "../surfaces/turn-driver.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { attachmentList, logAttachmentFailure } from "../surfaces/attachments.ts";
import {
  type PostMessageArgs,
  type SurfaceMessageReader,
  batchPostMessageArgs,
  botIdentityArgs,
  personaContinues,
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
import type { SlackStatusCard } from "./session-status.ts";

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
  readSurfaceMessages?: SurfaceMessageReader;
  onEngaged?: (runId: string, channel: string, threadTs?: string) => void;
  onSettled?: () => void;
  card?: (channel: string, threadTs: string) => Pick<SlackStatusCard, "posted"> | undefined;
}): SurfaceTransport {
  const { client, channel, threadTs } = at;
  const notices = new Set<string>();

  const post: SurfaceTransport["post"] = async (msg, opts = {}) => {
    const baseOpts = { threadOnly: at.kind === "channel", unfurlLinks: false, persona: opts.persona };
    const args: PostMessageArgs = opts.notice
      ? { ...slackReplyArgs(channel, msg, threadTs, baseOpts), blocks: noticeBlocks(msg) }
      : slackPersonaReplyArgs(channel, msg, threadTs, {
          ...baseOpts,
          webUiPublicUrl: at.webUiPublicUrl,
          ...(opts.note ? { footer: [plainContext(opts.note)] } : {}),
          hideOrigin: await personaContinues(at.readSurfaceMessages, { channel, threadTs }, opts.persona),
        });
    if (opts.idempotencyKey) {
      const posted = await postWithVerify(client, args, opts.idempotencyKey);
      const blocks = args.blocks as Record<string, unknown>[] | undefined;
      if (opts.runId && threadTs && posted.ts && !posted.parts)
        void at.card?.(channel, threadTs)?.posted({ text: msg, ...(blocks ? { blocks } : {}) }, posted.ts, opts.runId);
      return posted.ts;
    }
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
      if (!on) at.onSettled?.();
      else if (run && threadTs) at.onEngaged?.(run.runId, channel, threadTs);
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
