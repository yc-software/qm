export interface ReactionTally {
  name: string;
  count: number;
}

export function summarizeReactions(reactions: readonly ReactionTally[] | undefined): string {
  if (!reactions?.length) return "";
  return reactions
    .filter((r) => r.name && r.count > 0)
    .map((r) => (r.count > 1 ? `:${r.name}:×${r.count}` : `:${r.name}:`))
    .join(" ");
}

export function shouldSurfaceReaction(opts: {
  itemType: string | undefined;
  reactorId: string | undefined;
  botUserId: string;
  isDM: boolean;
  onBotMessage: boolean;
  onFollowedRoot: boolean;
}): boolean {
  if (opts.itemType !== "message") return false;
  if (!opts.reactorId) return false;
  if (opts.botUserId && opts.reactorId === opts.botUserId) return false;
  return opts.isDM || opts.onBotMessage || opts.onFollowedRoot;
}

export interface InboundReaction {
  surfaceLabel: string;
  reactorName: string;
  emoji: string;
  added: boolean;
  onBotMessage: boolean;
  authorName?: string;
  messageText?: string;
  reactions?: ReactionTally[];
}

const MAX_REACTION_QUOTE_CHARS = 280;

export function buildReactionTurnText(evt: InboundReaction): string {
  let whose = "a";
  if (evt.onBotMessage) whose = "your";
  else if (evt.authorName) whose = `${evt.authorName}'s`;
  const t = evt.messageText?.trim() ?? "";
  const quote = t ? `: "${t.length > MAX_REACTION_QUOTE_CHARS ? `${t.slice(0, MAX_REACTION_QUOTE_CHARS)}…` : t}"` : "";
  if (!evt.added) {
    return `[${evt.surfaceLabel} reaction] ${evt.reactorName} removed their :${evt.emoji}: reaction from ${whose} message${quote}.`;
  }
  const summary = summarizeReactions(evt.reactions);
  const now = summary ? ` (it now has ${summary})` : "";
  return `[${evt.surfaceLabel} reaction] ${evt.reactorName} reacted with :${evt.emoji}: on ${whose} message${quote}${now}.`;
}
