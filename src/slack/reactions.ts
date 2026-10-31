import { emojiNameOf } from "../surfaces/emoji-map.ts";
import { MAX_REACTIONS_PER_TURN } from "../surfaces/reactions.ts";
import { decodeTs, MESSAGE_ID_TOKEN } from "../surfaces/message-ids.ts";
import { reactionDetectGuidance } from "../surfaces/instructions.ts";
import { sleep } from "./util.ts";
import { extractDirectives } from "./directives.ts";
import { slackErrorCode } from "./payloads.ts";

const REACTION_DIRECTIVE = /\[\[react:([^[\]]*)\]\]/gi;
const TRAILING_OPEN_DIRECTIVE = /\[\[react:[^[\]]*$/i;
const REACTION_TS = /^\d{6,}\.\d{1,}$/;

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

export const REACTION_DETECT_GUIDANCE = reactionDetectGuidance("slack");

export function normalizeReaction(raw: string): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const fromChar = emojiNameOf(trimmed);
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
        const code = slackErrorCode(err);
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
    if (MESSAGE_ID_TOKEN.test(candidate)) {
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
