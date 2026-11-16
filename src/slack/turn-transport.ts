import type { SurfaceTransport } from "../surfaces/turn-driver.ts";
import { swallowAs } from "../util/errors.ts";
import {
  type PostMessageArgs,
  SLACK_POST_SPLIT_LIMIT,
  blocksWithContext,
  botIdentityArgs,
  plainContext,
  postWithVerify,
  resolveReactionTargets,
  safeChunks,
  slackReplyArgs,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
} from "./lib.ts";
import { applyAndLogReactions, cleanAgentReplyForSlack, updateSlackMessage } from "./messaging.ts";
import { escapeSlackText } from "./mrkdwn.ts";

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
  onEngaged?: (runId: string, channel: string, threadTs?: string, emoji?: Promise<string>) => void;
  onSettled?: () => void;
}): SurfaceTransport {
  const { client, channel, threadTs } = at;
  const notices = new Set<string>();

  const post: SurfaceTransport["post"] = async (msg, opts = {}) => {
    let blocks: Array<Record<string, unknown>> | undefined;
    if (opts.notice) blocks = noticeBlocks(msg);
    else if (opts.note) blocks = blocksWithContext(msg, [plainContext(opts.note)]);
    const replyArgs = (text: string, withBlocks: boolean): Record<string, unknown> => ({
      ...slackReplyArgs(channel, text, threadTs, { threadOnly: at.kind === "channel", unfurlLinks: false }),
      ...(withBlocks && blocks ? { blocks } : {}),
    });
    if (opts.idempotencyKey)
      return (await postWithVerify(client, replyArgs(msg, true) as PostMessageArgs, opts.idempotencyKey)).ts;
    const parts = blocks ? [msg] : safeChunks(msg, SLACK_POST_SPLIT_LIMIT);
    let firstTs: string | undefined;
    for (const [i, part] of parts.entries()) {
      const ts = (await client.chat.postMessage(replyArgs(part, parts.length === 1))).ts as string | undefined;
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
      else if (run && threadTs) at.onEngaged?.(run.runId, channel, threadTs, run.emoji());
    },
    async upload(attachments) {
      try {
        await uploadAttachments(client, channel, threadTs, attachments, at.blobs);
        return {};
      } catch (err) {
        console.error("[slack-plugin] file upload failed:", (err as Error).message);
        return { failureNote: uploadFailureNote(err) };
      }
    },
    render: toSlackMrkdwn,
    escape: escapeSlackText,
    readReply: cleanAgentReplyForSlack,
  };
}
