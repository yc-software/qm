import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CoreSession } from "./core-bridge";
import { REACTION_PREFIX, splitOnce } from "./slack-text.ts";

export function hiddenMessage(message: AgentMessage): boolean {
  const { opener, resumeAnchor } = message as { opener?: boolean; resumeAnchor?: boolean };
  return Boolean(opener || resumeAnchor);
}

export function continuedSpeakers(agents: boolean, rows: readonly AgentMessage[]): Set<AgentMessage> {
  const continued = new Set<AgentMessage>();
  let previous: string | undefined;
  for (const message of rows) {
    const { role, speaker, speakerId, personaId } = message as {
      role?: string;
      speaker?: string;
      speakerId?: string;
      personaId?: string;
    };
    const key = role === "user" ? speakerId || speaker : agents ? `${role}:${personaId ?? ""}` : undefined;
    if (key && key === previous) continued.add(message);
    previous = key;
  }
  return continued;
}

export function slackAppIcon(
  session: CoreSession | null,
  message: AgentMessage,
  iconUrl: string | null | undefined,
): string | undefined {
  const wornPersona = Boolean((message as { personaId?: string }).personaId);
  return session?.surface === "slack" && !wornPersona ? iconUrl || undefined : undefined;
}

export function fromSomeoneElse(message: AgentMessage, viewer: string | undefined): boolean {
  const { speakerId, overheard } = message as { speakerId?: string; overheard?: boolean };
  return speakerId ? Boolean(viewer) && speakerId !== viewer : Boolean(overheard);
}

export interface SlackReaction {
  who: string;
  emoji: string;
  added: boolean;
  onAgent: boolean;
  author: string | undefined;
  quote: string;
}

export function parseSlackReaction(text: string): SlackReaction | null {
  if (!text.startsWith(REACTION_PREFIX)) return null;
  const rest = text.slice(REACTION_PREFIX.length);
  const added = rest.includes(" reacted with :");
  const [who, tail] = splitOnce(rest, added ? " reacted with :" : " removed their :");
  const [emoji, after] = splitOnce(tail ?? "", ":");
  if (!who || !emoji || after === undefined) return null;
  const joint = added ? " on " : " reaction from ";
  const target = after.slice(after.indexOf(joint) + joint.length);
  const [whose, quoted] = splitOnce(target, ' message: "');
  const owner = quoted === undefined ? splitOnce(target, " message")[0] : whose;
  const close = quoted?.lastIndexOf('"') ?? -1;
  const quote = quoted === undefined ? "" : quoted.slice(0, close < 0 ? undefined : close);
  return {
    who,
    emoji,
    added,
    onAgent: owner === "your",
    author: owner.endsWith("'s") ? owner.slice(0, -2) : undefined,
    quote: quote.endsWith("…") ? quote.slice(0, -1) : quote,
  };
}

export function collectReactions(
  messages: readonly AgentMessage[],
  textOf: (message: AgentMessage) => string,
): { onMessage: Map<AgentMessage, Map<string, string[]>>; reactionRows: Set<AgentMessage> } {
  const onMessage = new Map<AgentMessage, Map<string, string[]>>();
  const reactionRows = new Set<AgentMessage>();
  messages.forEach((message, index) => {
    const role = (message as { role?: string }).role;
    const reaction = role === "user" ? parseSlackReaction(textOf(message)) : null;
    if (!reaction) return;
    const earlier = messages.slice(0, index).reverse();
    const byOwner = earlier.filter((m) =>
      reaction.onAgent
        ? (m as { role?: string }).role === "assistant"
        : !reactionRows.has(m) && (m as { speaker?: string }).speaker === reaction.author,
    );
    const quote = reaction.quote.trim();
    const target = (quote && byOwner.find((m) => textOf(m).trim().startsWith(quote))) || byOwner[0];
    if (!target) return;
    reactionRows.add(message);
    const tally = onMessage.get(target) ?? new Map<string, string[]>();
    const people = (tally.get(reaction.emoji) ?? []).filter((name) => name !== reaction.who);
    if (reaction.added) people.push(reaction.who);
    if (people.length) tally.set(reaction.emoji, people);
    else tally.delete(reaction.emoji);
    onMessage.set(target, tally);
  });
  return { onMessage, reactionRows };
}
