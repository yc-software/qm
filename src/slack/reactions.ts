import { emojiNameOf } from "./emoji-map.ts";
import { sleep } from "./util.ts";
import { slackErrorCode } from "./payloads.ts";
import { trimTrailing } from "../util/text.ts";
import {
  MAX_REACTIONS_PER_TURN,
  REACTION_ID,
  reactionDetectGuidance,
  reactionInstruction,
  type ReplyReaction,
} from "../surfaces/reactions.ts";

export type ReactionDirective = ReplyReaction;
export const REACTION_INSTRUCTION = reactionInstruction("Slack ", true);
export const REACTION_DETECT_GUIDANCE = reactionDetectGuidance("Slack ");

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

const SKIN_TONE_BY_MODIFIER: Record<string, string> = {
  "🏻": "2",
  "🏼": "3",
  "🏽": "4",
  "🏾": "5",
  "🏿": "6",
};
const SKIN_TONE_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/gu;

function emojiCharToName(s: string): string | null {
  let tone: string | undefined;
  const base = s.replace(SKIN_TONE_MODIFIER, (m) => {
    tone = SKIN_TONE_BY_MODIFIER[m];
    return "";
  });
  const name = emojiNameOf(base);
  if (!name) return null;
  return tone ? `${name}::skin-tone-${tone}` : name;
}

export function normalizeReaction(raw: string): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const fromChar = emojiCharToName(trimmed);
  if (fromChar) return fromChar;
  const name = trimTrailing(trimmed.replace(/^:+/, ""), (char) => char === ":")
    .trim()
    .toLowerCase();
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
