import type { ActorAssertion } from "../types.ts";
import type { DiscordMemberFacts } from "./members.ts";

export const DISCORD_AUDIENCE_CAP = 500;

export type ChannelViewers =
  | { ok: true; guildId: string; members: DiscordMemberFacts[] }
  | { ok: false; reason: "not_a_guild_channel" | "members_not_ready" };

export type ReaderResult =
  | { ok: true; readers: ActorAssertion[] }
  | { ok: false; retry: true; reason: "members_not_ready" }
  | { ok: false; retry: false; reason: "not_a_guild_channel" | "guild_not_configured" | "too_many_readers" };

export async function channelReaders(input: {
  viewers: ChannelViewers;
  guildIds: ReadonlySet<string>;
  ready: (guildId: string) => boolean;
  botUserId: string;
  classify: (m: DiscordMemberFacts) => Promise<ActorAssertion>;
  cap?: number;
}): Promise<ReaderResult> {
  const { viewers } = input;
  if (!viewers.ok)
    return viewers.reason === "members_not_ready"
      ? { ok: false, retry: true, reason: viewers.reason }
      : { ok: false, retry: false, reason: viewers.reason };
  if (!input.guildIds.has(viewers.guildId)) return { ok: false, retry: false, reason: "guild_not_configured" };
  if (!input.ready(viewers.guildId)) return { ok: false, retry: true, reason: "members_not_ready" };
  const people = [...new Map(viewers.members.map((m) => [m.userId, m])).values()].filter(
    (m) => m.userId !== input.botUserId,
  );
  if (people.length > (input.cap ?? DISCORD_AUDIENCE_CAP))
    return { ok: false, retry: false, reason: "too_many_readers" };
  return { ok: true, readers: await Promise.all(people.map((m) => input.classify(m))) };
}

export function audienceWith(readers: readonly ActorAssertion[], actor: ActorAssertion): ActorAssertion[] {
  return readers.some((a) => a.externalId === actor.externalId) ? [...readers] : [...readers, actor];
}

export function turnPostGate(
  readersOf: (channelId: string) => Promise<ReaderResult>,
  channelId: string,
): () => Promise<boolean> {
  let verdict: boolean | null = null;
  return async () => {
    if (verdict !== null) return verdict;
    const res = await readersOf(channelId);
    if (!res.ok && res.retry) return false;
    return (verdict = res.ok && !res.readers.some((r) => r.isExternalGuest));
  };
}
