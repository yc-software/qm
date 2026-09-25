import { swallowAs } from "../util/errors.ts";
import { CURATED_ACK_EMOJI, DEFAULT_ACK_REACTIONS } from "./lib.ts";
import { EMOJI_NAME_BY_CHAR } from "./emoji-map.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";

export interface AckEmojiPicker {
  refreshAckEmoji(client: any): void;
  ackPickCandidates(client: any): string[];
  requestAckEmoji(
    text: string,
    candidates: readonly string[],
    ctx: { channel: string; ts: string },
  ): Promise<string | undefined>;
}

const ACK_EMOJI_TTL_MS = 60 * 60_000;
const COMPLETION_EMOJI = /check|done|complete|approved|ship|tada|party|100|thumbsup|\+1|yes/i;

const NAME_TO_CHAR: Record<string, string> = {};
for (const [char, name] of Object.entries(EMOJI_NAME_BY_CHAR)) if (!(name in NAME_TO_CHAR)) NAME_TO_CHAR[name] = char;

const CUSTOM_PICK_SAMPLE = 40;
function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

export function createAckEmojiPicker(
  core: SlackCoreClient,
  opts: { candidatesOverride?: () => readonly string[] | null } = {},
): AckEmojiPicker {
  let ackEmojiCache: { custom: string[]; urls: Record<string, string>; at: number } | null = null;
  let ackEmojiInFlight: Promise<void> | null = null;
  function refreshAckEmoji(client: any): void {
    if (ackEmojiInFlight || (ackEmojiCache && Date.now() - ackEmojiCache.at < ACK_EMOJI_TTL_MS)) return;
    ackEmojiInFlight = Promise.resolve(client.emoji.list())
      .then((res: { emoji?: Record<string, string> }) => {
        const urls: Record<string, string> = {};
        for (const [name, url] of Object.entries(res.emoji ?? {})) {
          if (typeof url === "string" && !url.startsWith("alias:") && !COMPLETION_EMOJI.test(name)) urls[name] = url;
        }
        ackEmojiCache = { custom: Object.keys(urls), urls, at: Date.now() };
      })
      .catch(swallowAs("slack: emoji.list", undefined))
      .finally(() => {
        ackEmojiInFlight = null;
      });
  }

  function resolveEmojiIcon(name: string): string | undefined {
    return ackEmojiCache?.urls[name] ?? NAME_TO_CHAR[name];
  }

  function ackPickCandidates(client: any): string[] {
    const override = opts.candidatesOverride?.();
    if (override?.length) return [...override];
    refreshAckEmoji(client);
    return [...CURATED_ACK_EMOJI, ...DEFAULT_ACK_REACTIONS, ...sample(ackEmojiCache?.custom ?? [], CUSTOM_PICK_SAMPLE)];
  }

  function requestAckEmoji(
    text: string,
    candidates: readonly string[],
    ctx: { channel: string; ts: string },
  ): Promise<string | undefined> {
    if (!text.trim() || candidates.length === 0) return Promise.resolve(undefined);
    const startedAt = Date.now();
    return core
      .pickAckEmoji(text, candidates)
      .catch(swallowAs("slack: ack-emoji pick", undefined))
      .then((picked) => {
        const icon = picked ? resolveEmojiIcon(picked) : undefined;
        void core
          .recordAckPick({
            channel: ctx.channel,
            ts: ctx.ts,
            outcome: picked ? "picked" : "declined",
            ...(picked ? { picked } : {}),
            ...(icon ? { icon } : {}),
            message: text.slice(0, 300),
            candidates: candidates.join(" "),
            latencyMs: Date.now() - startedAt,
          })
          .catch(swallowAs("slack: ack-emoji record", undefined));
        return picked;
      });
  }

  return { refreshAckEmoji, ackPickCandidates, requestAckEmoji };
}
