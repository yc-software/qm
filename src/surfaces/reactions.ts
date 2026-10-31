import { surfaceLabel } from "./surface-capabilities.ts";
import { summarizeReactions, type ReactionTally } from "./reaction-tally.ts";

export const MAX_REACTIONS_PER_TURN = 5;
export const REACTION_ITEM_MESSAGE = "message";
const MAX_REACTION_QUOTE_CHARS = 280;

export function shouldSurfaceReaction(opts: {
  itemType: string | undefined;
  reactorId: string | undefined;
  botUserId: string;
  isDM: boolean;
  onBotMessage: boolean;
  onFollowedRoot: boolean;
}): boolean {
  if (opts.itemType !== REACTION_ITEM_MESSAGE) return false;
  if (!opts.reactorId) return false;
  if (opts.botUserId && opts.reactorId === opts.botUserId) return false;
  return opts.isDM || opts.onBotMessage || opts.onFollowedRoot;
}

export interface InboundReaction {
  reactorName: string;
  emoji: string;
  added: boolean;
  onBotMessage: boolean;
  authorName?: string;
  messageText?: string;
  reactions?: ReactionTally[];
}

export function buildReactionTurnText(surface: string, evt: InboundReaction): string {
  const tag = `[${surfaceLabel(surface)} reaction]`;
  let whose = "a";
  if (evt.onBotMessage) whose = "your";
  else if (evt.authorName) whose = `${evt.authorName}'s`;
  const t = evt.messageText?.trim() ?? "";
  const quote = t ? `: "${t.length > MAX_REACTION_QUOTE_CHARS ? `${t.slice(0, MAX_REACTION_QUOTE_CHARS)}…` : t}"` : "";
  if (!evt.added) {
    return `${tag} ${evt.reactorName} removed their :${evt.emoji}: reaction from ${whose} message${quote}.`;
  }
  const summary = summarizeReactions(evt.reactions);
  const now = summary ? ` (it now has ${summary})` : "";
  return `${tag} ${evt.reactorName} reacted with :${evt.emoji}: on ${whose} message${quote}${now}.`;
}
