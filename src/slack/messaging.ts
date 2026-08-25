import {
  type ActorAssertion,
  type AgentRequestDirective,
  type ReactionDirective,
  AGENT_REQUEST_INSTRUCTION,
  MAX_REACTIONS_PER_TURN,
  REACTION_INSTRUCTION,
  applyReactions,
  botIdentityArgs,
  extractAgentRequests,
  extractMiniapps,
  extractReactions,
  stripAgentRequestDirectives,
  stripMiniappDirectives,
  stripReactionDirectives,
  type MiniappEmbed,
} from "./lib.ts";

export type SlackConversationKind = "dm" | "channel" | "group";

const SLACK_TEXT_LIMIT = 40000;

export async function updateSlackMessage(
  client: any,
  channel: string,
  ts: string | undefined,
  text: string,
  blocks?: Array<Record<string, unknown>>,
): Promise<boolean> {
  if (!ts) return false;
  await client.chat.update({
    channel,
    ts,
    text: text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT - 1)}…` : text,
    ...botIdentityArgs(),
    unfurl_links: false,
    unfurl_media: false,
    blocks: blocks ?? [],
  });
  return true;
}

export async function tryUpdateSlackMessage(
  client: any,
  channel: string,
  ts: string | undefined,
  text: string,
  blocks?: Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    return await updateSlackMessage(client, channel, ts, text, blocks);
  } catch (err) {
    console.error("[slack-plugin] chat.update failed:", (err as Error).message);
    return false;
  }
}

export function cleanAgentReplyForSlack(text: string): {
  text: string;
  reactions: ReactionDirective[];
  agentRequests: AgentRequestDirective[];
  miniapps: MiniappEmbed[];
} {
  const extractedReactions = extractReactions(text);
  const extractedRequests = extractAgentRequests(extractedReactions.text);
  const extractedMiniapps = extractMiniapps(extractedRequests.text);
  return {
    text: extractedMiniapps.text,
    reactions: extractedReactions.reactions,
    agentRequests: extractedRequests.requests,
    miniapps: extractedMiniapps.miniapps,
  };
}

export function slackSurfaceInstructions(kind: SlackConversationKind): string {
  return kind === "dm" ? REACTION_INSTRUCTION : `${REACTION_INSTRUCTION}\n\n${AGENT_REQUEST_INSTRUCTION}`;
}

export function stripSlackDirectives(text: string): string {
  return stripMiniappDirectives(stripAgentRequestDirectives(stripReactionDirectives(text)));
}

export async function applyAndLogReactions(
  client: any,
  channel: string,
  defaultTs: string | undefined,
  directives: readonly ReactionDirective[],
): Promise<void> {
  let budget = MAX_REACTIONS_PER_TURN;
  for (const d of directives) {
    if (budget <= 0) break;
    const timestamp = d.target ?? defaultTs;
    if (!d.names.length || !timestamp) continue;
    const { added, failed } = await applyReactions(client, channel, timestamp, d.names.slice(0, budget));
    budget -= added.length + failed.length;
    if (failed.length) {
      console.error(
        `[slack-plugin] couldn't add reaction(s): ${failed.join(", ")} on ${timestamp} (check the reactions:write scope / message ts)`,
      );
    }
  }
}

function possessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Their";
  return trimmed.endsWith("s") || trimmed.endsWith("S") ? `${trimmed}'` : `${trimmed}'s`;
}

export function conversationPlaceLabel(
  kind: SlackConversationKind,
  channelName: string | undefined,
  channel: string,
): string {
  if (kind === "group") return channelName ? `group DM (${channelName})` : "group DM";
  return channelName ? `#${channelName}` : `channel ${channel}`;
}

export function channelAgentLabel(
  kind: SlackConversationKind,
  channelName: string | undefined,
  channel: string,
): string {
  if (kind === "group") return channelName ? `group DM (${channelName}) agent` : "group DM agent";
  return channelName ? `#${channelName} agent` : `channel ${channel} agent`;
}

export function personalAgentLabel(actor: ActorAssertion | undefined, userId: string): string {
  const name = actor?.displayName?.trim() || userId;
  return `${possessive(name)} personal agent`;
}
