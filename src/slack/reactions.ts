import { EMOJI_NAME_BY_CHAR } from "./emoji-map.ts";
import { sleep } from "./util.ts";
import { extractDirectives } from "./directives.ts";

const REACTION_DIRECTIVE = /\[\[react:\s*([^\]]*)\]\]/gi;
const TRAILING_OPEN_DIRECTIVE = /\[\[react:[^\]]*$/i;
const REACTION_TS = /^\d{6,}\.\d{1,}$/;
const REACTION_ID = /^~([0-9a-z]+)$/;

export function encodeTs(ts: string): string {
  const m = /^(\d{6,})\.(\d{1,6})$/.exec(String(ts).trim());
  if (!m) return "";
  const seconds = Number(m[1]);
  const micros = Number(m[2]!.padEnd(6, "0"));
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros)) return "";
  const packed = seconds * 1_000_000 + micros;
  if (!Number.isSafeInteger(packed)) return "";
  return `~${packed.toString(36)}`;
}

export function decodeTs(id: string): string | null {
  const m = REACTION_ID.exec(String(id).trim());
  if (!m) return null;
  const packed = parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(packed) || packed <= 0) return null;
  const seconds = Math.floor(packed / 1_000_000);
  const micros = packed % 1_000_000;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

export const REACTION_INSTRUCTION =
  "When a Slack user explicitly asks you to add an emoji reaction, you MUST actually react by writing " +
  "the directive `[[react: name1 name2]]` somewhere in your reply, using Slack emoji short-names " +
  "with NO colons (e.g. `[[react: eyes white_check_mark]]`). Do not satisfy an explicit reaction request by " +
  "typing the emoji into your prose; an emoji in your text does nothing — only the directive adds a " +
  "real Slack reaction from the assistant reply. When the user names or describes the emoji in words, translate it to your best-guess " +
  'short-name rather than giving up — for example "react with a salute" → `[[react: saluting_face]]`, ' +
  '"give me a thumbs up" → `[[react: +1]]`, "drop a 🎉 on this" → `[[react: tada]]`. The plugin strips ' +
  "the directive from what the user sees and adds those reactions (up to 5) to the message you're " +
  "answering, so a reply can be JUST the directive with no other text, or the directive alongside " +
  "normal text. Unknown names are dropped silently, so pick the closest real short-name you can. " +
  "By DEFAULT the reaction lands on the message you're replying to. To react to a DIFFERENT message " +
  "instead — e.g. someone else's earlier message in this conversation — find it in the conversation " +
  "above: each message carries a short id in brackets like `[~abc123]`. Append `@` and that exact id " +
  'inside the directive: `[[react: saluting_face @ ~abc123]]`. For "react to Alice\'s last message", ' +
  "find Alice's most recent line and copy its `[~id]`. Copy the id verbatim, including the leading `~`. " +
  "One directive reacts to one message; use several directives to react to several messages. " +
  "Use this directive when the user's request is specifically to react, or when the best complete Slack response is only " +
  "an acknowledgement reaction. Do not use it instead of answering a request that needs words.";

export const REACTION_DETECT_GUIDANCE =
  "Express the reaction as one Slack emoji short-name written WITH colons (e.g. `:pray:`), the one " +
  "THIS persona would naturally reach for — common picks: `:pray:` (thanks), `:+1:` (got it), " +
  "`:rocket:`/`:tada:` (a win), `:eyes:` (on it) — but choose whatever genuinely fits, not a fixed menu.";

export const MAX_REACTIONS_PER_TURN = 5;

const SKIN_TONE_BY_MODIFIER: Record<string, string> = {
  "🏻": "2",
  "🏼": "3",
  "🏽": "4",
  "🏾": "5",
  "🏿": "6",
};
const SKIN_TONE_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/gu;
const VARIATION_SELECTOR_16 = /️/g;

function emojiCharToName(s: string): string | null {
  let tone: string | undefined;
  const base = s
    .replace(SKIN_TONE_MODIFIER, (m) => {
      tone = SKIN_TONE_BY_MODIFIER[m];
      return "";
    })
    .replace(VARIATION_SELECTOR_16, "");
  const name = EMOJI_NAME_BY_CHAR[base];
  if (!name) return null;
  return tone ? `${name}::skin-tone-${tone}` : name;
}

export function normalizeReaction(raw: string): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const fromChar = emojiCharToName(trimmed);
  if (fromChar) return fromChar;
  const name = trimmed.replace(/^:+/, "").replace(/:+$/, "").trim().toLowerCase();
  if (!/^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/.test(name)) return null;
  return name;
}

export function normalizeReactions(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names ?? []) {
    const n = normalizeReaction(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_REACTIONS_PER_TURN) break;
  }
  return out;
}

export interface ReactionClient {
  reactions: { add(args: { channel: string; timestamp: string; name: string }): Promise<unknown> };
}

const REACTION_PROPAGATION_ERRORS = new Set(["invalid_name", "not_reactable", "no_reaction"]);
const REACTION_RETRY_DELAYS_MS = [1500, 2500, 3000] as const;

export async function applyReactions(
  client: ReactionClient,
  channel: string,
  timestamp: string,
  names: readonly string[],
): Promise<{ added: string[]; failed: string[] }> {
  const added: string[] = [];
  const failed: string[] = [];
  for (const name of normalizeReactions(names)) {
    let landed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        await client.reactions.add({ channel, timestamp, name });
        landed = true;
        break;
      } catch (err) {
        const code = (err as { data?: { error?: string } })?.data?.error;
        if (code === "already_reacted") {
          landed = true;
          break;
        }
        const delay = REACTION_RETRY_DELAYS_MS[attempt];
        if (code && REACTION_PROPAGATION_ERRORS.has(code) && delay != null) {
          await sleep(delay);
          continue;
        }
        break;
      }
    }
    (landed ? added : failed).push(name);
  }
  return { added, failed };
}

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
    return `[Slack reaction] ${evt.reactorName} removed their :${evt.emoji}: reaction from ${whose} message${quote}.`;
  }
  const summary = summarizeReactions(evt.reactions);
  const now = summary ? ` (it now has ${summary})` : "";
  return `[Slack reaction] ${evt.reactorName} reacted with :${evt.emoji}: on ${whose} message${quote}${now}.`;
}

export interface ReactionDirective {
  names: string[];
  target?: string;
  targetId?: string;
}

export function parseReactionGroup(inner: string): ReactionDirective {
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

export function resolveReactionTargets(
  reactions: readonly ReactionDirective[],
  allowedTs: ReadonlySet<string>,
): { directives: ReactionDirective[]; dropped: number } {
  const directives: ReactionDirective[] = [];
  let dropped = 0;
  for (const d of reactions) {
    if (d.targetId == null && d.target == null) {
      directives.push(d);
      continue;
    }
    const ts = d.targetId != null ? decodeTs(d.targetId) : d.target;
    if (ts && allowedTs.has(ts)) directives.push({ names: d.names, target: ts });
    else dropped++;
  }
  return { directives, dropped };
}

export function extractReactions(reply: string): { text: string; reactions: ReactionDirective[] } {
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
