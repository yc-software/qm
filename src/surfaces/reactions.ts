import { extractDirectives } from "./reply-directives.ts";

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

export interface ReplyReaction {
  names: string[];
  target?: string;
  targetId?: string;
}

const REACTION_DIRECTIVE = /\[\[react:([^[\]]*)\]\]/gi;
const TRAILING_OPEN_DIRECTIVE = /\[\[react:[^[\]]*$/i;
const REACTION_TS = /^\d{6,}\.\d{1,}$/;
export const REACTION_ID = /^~([0-9a-z]+)$/;

export const MAX_REACTIONS_PER_TURN = 5;

export function reactionInstruction(place: string, otherMessages: boolean): string {
  return (
    `When a ${place}user explicitly asks you to add an emoji reaction, you MUST actually react by writing ` +
    `the directive \`[[react: name1 name2]]\` somewhere in your reply, using ${place}emoji short-names ` +
    "with NO colons (e.g. `[[react: eyes white_check_mark]]`). Do not satisfy an explicit reaction request by " +
    "typing the emoji into your prose; an emoji in your text does nothing — only the directive adds a " +
    `real ${place}reaction from the assistant reply. When the user names or describes the emoji in words, translate it to your best-guess ` +
    'short-name rather than giving up — for example "react with a salute" → `[[react: saluting_face]]`, ' +
    '"give me a thumbs up" → `[[react: +1]]`, "drop a 🎉 on this" → `[[react: tada]]`. The plugin strips ' +
    "the directive from what the user sees and adds those reactions (up to 5) to the message you're " +
    "answering, so a reply can be JUST the directive with no other text, or the directive alongside " +
    "normal text. Unknown names are dropped silently, so pick the closest real short-name you can. " +
    (otherMessages
      ? "By DEFAULT the reaction lands on the message you're replying to. To react to a DIFFERENT message " +
        "instead — e.g. someone else's earlier message in this conversation — find it in the conversation " +
        "above: each message carries a short id in brackets like `[~abc123]`. Append `@` and that exact id " +
        'inside the directive: `[[react: saluting_face @ ~abc123]]`. For "react to Alice\'s last message", ' +
        "find Alice's most recent line and copy its `[~id]`. Copy the id verbatim, including the leading `~`. " +
        "One directive reacts to one message; use several directives to react to several messages. "
      : "") +
    `Use this directive when the user's request is specifically to react, or when the best complete ${place}response is only ` +
    "an acknowledgement reaction. Do not use it instead of answering a request that needs words."
  );
}

export function reactionDetectGuidance(place: string): string {
  return (
    `Express the reaction as one ${place}emoji short-name written WITH colons (e.g. \`:pray:\`), the one ` +
    "THIS persona would naturally reach for — common picks: `:pray:` (thanks), `:+1:` (got it), " +
    "`:rocket:`/`:tada:` (a win), `:eyes:` (on it) — but choose whatever genuinely fits, not a fixed menu."
  );
}

export function parseReactionGroup(inner: string): ReplyReaction {
  let namesPart = String(inner);
  let target: string | undefined;
  let targetId: string | undefined;
  const at = namesPart.lastIndexOf("@");
  if (at >= 0) {
    const candidate = namesPart.slice(at + 1).trim();
    if (REACTION_ID.test(candidate)) {
      targetId = candidate;
      namesPart = namesPart.slice(0, at);
    } else if (REACTION_TS.test(candidate)) {
      target = candidate;
      namesPart = namesPart.slice(0, at);
    }
  }
  const names: string[] = [];
  for (const n of namesPart.split(/[\s,]+/)) {
    const t = n.trim();
    if (t) names.push(t);
  }
  return { names, ...(target ? { target } : {}), ...(targetId ? { targetId } : {}) };
}

export function extractReactions(reply: string): { text: string; reactions: ReplyReaction[] } {
  const { text, matches } = extractDirectives(reply, REACTION_DIRECTIVE, TRAILING_OPEN_DIRECTIVE, ([inner]) => {
    const group = parseReactionGroup(inner ?? "");
    return group.names.length ? group : undefined;
  });
  return { text, reactions: matches };
}

export function stripReactionDirectives(partial: string): string {
  if (!partial) return partial ?? "";
  return partial.replace(REACTION_DIRECTIVE, "").replace(TRAILING_OPEN_DIRECTIVE, "");
}
