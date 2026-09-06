import { WebClient } from "@slack/web-api";
import type { LoopItem, LoopSourcePayload } from "../../types.ts";
import { normalizeSlackApiUrl } from "../../slack/config.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../../slack/delivery.ts";
import { neutralizeMentions, wireMentionKeys } from "../../slack/mrkdwn.ts";
import { agentDraftsOf } from "../item-ledger.ts";
import { safeChunks } from "../../slack/safe-cut.ts";
import { applyReactions, normalizeReaction } from "../../slack/reactions.ts";
import { slackErrorCode } from "../../slack/payloads.ts";
import { errMessage } from "../../util/errors.ts";
import {
  clip,
  clipOpt,
  draftOf,
  isObj,
  parseCommonFields,
  parseReplyDraft,
  tokenFor,
  type LoopSourceAdapter,
  type ParsedEntry,
  type ReplyDraft,
  type SlackUserClient,
  type SourceActionDeps,
  type SourceActionResult,
} from "./adapter.ts";

const SLACK_HOST = "slack.com";

interface SlackMeta {
  channelId: string;
  channelLabel?: string;
  ts: string;
  threadTs?: string;
}

function parseSlackMeta(v: unknown): SlackMeta | undefined {
  if (!isObj(v)) return undefined;
  const channelId = clip(v.channelId, 60);
  const ts = clip(v.ts, 40);
  if (!channelId || !ts) return undefined;
  const channelLabel = clipOpt(v.channelLabel, 120);
  const threadTs = clipOpt(v.threadTs, 40);
  return { channelId, ts, ...(channelLabel ? { channelLabel } : {}), ...(threadTs ? { threadTs } : {}) };
}

function metaOf(item: LoopItem): SlackMeta | undefined {
  return parseSlackMeta(item.sourcePayload?.slack);
}

export function slackConversationRef(channelId: string, ts: string, threadTs?: string): string {
  const dm = channelId.startsWith("D") || channelId.startsWith("G");
  return dm ? channelId : `${channelId}:${threadTs ?? ts}`;
}

export function slackReplyThreadTs(item: LoopItem): string | undefined {
  const slack = metaOf(item);
  if (!slack) return undefined;
  if (slack.threadTs) return slack.threadTs;
  const dm = slack.channelId.startsWith("D") || slack.channelId.startsWith("G");
  return dm ? undefined : slack.ts;
}

function itemReactions(item: LoopItem): string[] {
  const raw = item.sourcePayload?.reactions;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
}

export function slackUserClientFactory(apiUrl?: string): (token: string) => SlackUserClient {
  const options = apiUrl ? { slackApiUrl: normalizeSlackApiUrl(apiUrl) } : {};
  return (token) => new WebClient(token, options);
}

const defaultSlackClient = slackUserClientFactory();

async function clientAsUser(deps: SourceActionDeps): Promise<SlackUserClient | null> {
  const token = await tokenFor(deps.tokens, SLACK_HOST, deps.owner);
  if (!token) return null;
  return (deps.slackClient ?? defaultSlackClient)(token);
}

const notConnected: SourceActionResult = {
  ok: false,
  reason: "not_connected",
  message: "Slack is not connected for this account",
};

function agentDraftBodies(item: LoopItem): string[] {
  return agentDraftsOf(item).flatMap((d) => {
    const body = parseReplyDraft(d.data)?.body;
    return body === undefined ? [] : [body.trim()];
  });
}

function provenanceUnknown(item: LoopItem): boolean {
  return item.agentDrafts === undefined && item.proposal?.by === "human";
}

export function renderSlackSendText(item: LoopItem, body: string, actor: "human" | "agent" = "human"): string {
  const agentBodies = agentDraftBodies(item);
  if (actor === "agent" || provenanceUnknown(item) || agentBodies.includes(body.trim()))
    return neutralizeMentions(body);
  const everWritten = new Set([
    ...(item.agentMentionKeys ?? []),
    ...agentBodies.flatMap((b) => [...wireMentionKeys(b)]),
  ]);
  return everWritten.size ? neutralizeMentions(body, everWritten) : body;
}

async function sendSlack(deps: SourceActionDeps, item: LoopItem, draft: ReplyDraft): Promise<SourceActionResult> {
  const slack = metaOf(item);
  if (!slack?.channelId) return { ok: false, reason: "bad_item", message: "item carries no Slack channel" };
  const client = await clientAsUser(deps);
  if (!client) return notConnected;
  const threadTs = slackReplyThreadTs(item);
  const parts = safeChunks(renderSlackSendText(item, draft.body, deps.actor ?? "human"), SLACK_POST_SPLIT_LIMIT);
  const posted: string[] = [];
  for (const text of parts) {
    try {
      await client.chat.postMessage({
        channel: slack.channelId,
        text,
        parse: "none",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      if (!posted.length) throw err;
      const code = slackErrorCode(err);
      return {
        ok: false,
        reason: "upstream",
        partial: true,
        message: `Slack posted ${posted.length} of ${parts.length} parts, then refused the next${code ? `: ${code}` : ""}. The reply is incomplete in Slack.`,
      };
    }
    posted.push(text);
  }
  return { ok: true, result: posted.join("\n") };
}

async function reactInSlack(deps: SourceActionDeps, item: LoopItem, raw: unknown): Promise<SourceActionResult> {
  const slack = metaOf(item);
  if (!slack?.channelId) return { ok: false, reason: "bad_item", message: "item carries no Slack channel" };
  const name = typeof raw === "string" ? normalizeReaction(raw) : null;
  if (!name) return { ok: false, reason: "bad_item", message: "name (an emoji short name) required" };
  const client = await clientAsUser(deps);
  if (!client) return notConnected;
  const { added } = await applyReactions(client, slack.channelId, slack.ts, [name]);
  if (!added.includes(name)) {
    return { ok: false, reason: "upstream", message: `Slack refused the reaction :${name}:` };
  }
  return {
    ok: true,
    result: `:${name}:`,
    resolves: false,
    payloadPatch: { reactions: [...new Set([...itemReactions(item), name])] } as LoopSourcePayload,
  };
}

export const slackAdapter: LoopSourceAdapter = {
  id: "slack",
  actions: ["send", "react"],
  parse(raw) {
    const common = parseCommonFields(raw);
    if ("error" in common) return common;
    const rawKey = clip(raw.sourceKey ?? raw.dedupeKey, 300);
    if (!rawKey) return { error: "sourceKey required" };
    const slack = parseSlackMeta(raw.slack);
    if (!slack) return { error: "slack items need slack.channelId and slack.ts" };
    const dedupeKey = slackConversationRef(slack.channelId, slack.ts, slack.threadTs);
    const draft = raw.draft === undefined ? undefined : parseReplyDraft(raw.draft);
    if (draft === null) return { error: "draft needs a string body" };
    const entry: ParsedEntry = {
      dedupeKey,
      summary: common.snippet,
      sourceAt: common.receivedAt,
      sourcePayload: { source: "slack", ...common, slack } as LoopSourcePayload,
      ...(draft ? { proposal: { data: draft as unknown as LoopSourcePayload } } : {}),
    };
    return entry;
  },
  matchesEvent(item, conversationRef) {
    const slack = metaOf(item);
    if (!slack) return false;
    return slackConversationRef(slack.channelId, slack.ts, slack.threadTs) === conversationRef;
  },
  parseProposal(raw) {
    const draft = parseReplyDraft(raw);
    return draft ? (draft as unknown as LoopSourcePayload) : null;
  },
  async act(deps, item, kind, args) {
    if (kind !== "send" && kind !== "react") {
      return { ok: false, reason: "bad_item", message: `slack items do not support "${kind}"` };
    }
    try {
      if (kind === "react") return await reactInSlack(deps, item, args.name);
      const draft = parseReplyDraft(args) ?? draftOf(item);
      if (!draft || !draft.body.trim()) return { ok: false, reason: "bad_item", message: "the draft is empty" };
      return await sendSlack(deps, item, { ...draft, body: draft.body.trim() });
    } catch (err) {
      const code = slackErrorCode(err);
      return { ok: false, reason: "upstream", message: code ? `Slack refused the ${kind}: ${code}` : errMessage(err) };
    }
  },
};
