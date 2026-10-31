import { ChannelType, type Channel } from "discord.js";
import type { ChannelMembership, DirectoryChannel } from "../directory/directory-store.ts";
import type { ActorAssertion } from "../types.ts";
import { sleep } from "../util/async.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { discordUserIdOf } from "./config.ts";
import { DISCORD_DIRECTORY_SYNC_MS } from "./directory.ts";
import { channelViewers, type DiscordChannels } from "./gateway.ts";
import { channelReaders } from "./readers.ts";
import type { DiscordMemberFacts } from "./members.ts";

export const DISCORD_ROSTER_ATTEMPTS = 3;
export const DISCORD_ROSTER_RETRY_MS = 2_000;
export const DISCORD_ROSTER_KEEP_MS = 2 * DISCORD_DIRECTORY_SYNC_MS;

export interface DiscordRoster {
  channels: DirectoryChannel[];
  members: ChannelMembership[];
  keep: string[];
}

export interface RosterComputation {
  roster: DiscordRoster;
  unready: boolean;
  skipped: boolean;
  fetched: string[];
}

export interface RosterInventoryDeps {
  channels: DiscordChannels;
  guildIds: ReadonlySet<string>;
  ready(guildId: string): boolean;
  botUserId: string;
  lastMembersOk: Map<string, number>;
  classify(userId: string, fallbackName: string): Promise<ActorAssertion>;
}

type GuildTextChannel = Channel & { name: string; guildId: string };

const isRosterChannel = (ch: Channel, guildIds: ReadonlySet<string>): ch is GuildTextChannel =>
  ch.isTextBased() &&
  !ch.isDMBased() &&
  !ch.isVoiceBased() &&
  guildIds.has(ch.guildId) &&
  (!ch.isThread() || ch.type === ChannelType.PrivateThread);

export async function computeDiscordRoster(deps: RosterInventoryDeps): Promise<RosterComputation> {
  const classified = new Map<string, Promise<ActorAssertion>>();
  const classify = (m: DiscordMemberFacts) => {
    let actor = classified.get(m.userId);
    if (!actor) classified.set(m.userId, (actor = deps.classify(m.userId, m.displayName)));
    return actor;
  };
  const keep: string[] = [];
  let skipped = false;
  const fetched: string[] = [];
  const channels: DirectoryChannel[] = [];
  const members: ChannelMembership[] = [];
  for (const ch of deps.channels.unlinkedCache()) {
    if (!isRosterChannel(ch, deps.guildIds)) continue;
    const viewers = await channelViewers(deps.channels, ch.id, Infinity);
    const readers = await channelReaders({
      viewers,
      guildIds: deps.guildIds,
      ready: deps.ready,
      botUserId: deps.botUserId,
      classify: classify,
      cap: Infinity,
    });
    if (!readers.ok || !viewers.ok) {
      if (!readers.ok && readers.retry) {
        skipped = true;
        if (Date.now() - (deps.lastMembersOk.get(ch.id) ?? -Infinity) <= DISCORD_ROSTER_KEEP_MS) keep.push(ch.id);
      }
      continue;
    }
    fetched.push(ch.id);
    const unlisted = new Set(viewers.members.filter((m) => m.pending || m.viewOnly).map((m) => m.userId));
    const exposed = readers.readers.some((a) => a.isExternalGuest);
    channels.push({
      channelId: ch.id,
      name: ch.name,
      isPrivate: true,
      ...(exposed ? { isExternal: true } : {}),
    });
    for (const a of readers.readers) {
      if (!a.isExternalGuest && !a.isBot && !unlisted.has(discordUserIdOf(a.externalId) ?? ""))
        members.push({ channelId: ch.id, principalId: a.externalId });
    }
  }
  const unhydrated = [...deps.guildIds].filter((g) => !deps.ready(g));
  if (unhydrated.length)
    swallow("discord: channel roster", new Error(`guilds not hydrated, roster not pushed: ${unhydrated.join(",")}`));
  return { roster: { channels, members, keep }, unready: unhydrated.length > 0, skipped, fetched };
}

export interface RosterSyncDeps {
  compute(): Promise<RosterComputation>;
  hold<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  push(roster: DiscordRoster, syncedAt: number): Promise<boolean>;
  lastMembersOk: Map<string, number>;
  retryMs: number;
}

export function createChannelRosterSync(deps: RosterSyncDeps): () => Promise<void> {
  let dirty = false;
  let loop: Promise<void> | null = null;
  let lastStamp = 0;

  async function attempt(): Promise<boolean> {
    const pushed = await deps.hold(async (lost) => {
      let leaseLost = false;
      void lost.then(() => {
        leaseLost = true;
      });
      lastStamp = Math.max(Date.now(), lastStamp + 1);
      const syncedAt = lastStamp;
      const { roster, unready, skipped, fetched } = await deps.compute();
      if (unready || leaseLost) return false;
      if (!(await deps.push(roster, syncedAt))) return false;
      for (const id of fetched) deps.lastMembersOk.set(id, Date.now());
      return !skipped;
    });
    return pushed === true;
  }

  async function drain(): Promise<void> {
    let failures = 0;
    try {
      while (dirty) {
        dirty = false;
        if (await attempt().catch(swallowAs("discord: channel roster sync", false))) {
          failures = 0;
          continue;
        }
        if (++failures >= DISCORD_ROSTER_ATTEMPTS) {
          swallow("discord: channel roster sync", new Error(`gave up after ${failures} failed attempts`));
          break;
        }
        dirty = true;
        await sleep(deps.retryMs);
      }
    } finally {
      loop = null;
    }
  }

  return () => {
    dirty = true;
    loop ??= drain();
    return loop;
  };
}

export const syncDirectoryAndRosters =
  (directory: () => Promise<void>, rosters: () => Promise<void>) => async (): Promise<void> => {
    await directory().catch(swallowAs("discord: directory sync", undefined));
    await rosters();
  };
