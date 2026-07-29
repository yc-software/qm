import {
  type ActorAssertion,
  type CachedUser,
  type ChannelMeta,
  type SlackIdentityMode,
  type SlackUser,
  allInternalChannelMembers,
  classifyUser,
  createRefreshCoalescer,
  createUserCache,
  externalMarker,
  isReservedMentionName,
  probeIdentityMode,
  resolveChannelMembership,
  setMentionIndex,
  slackUserTimezone,
  sleep,
} from "./lib.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";

export interface BotIdentity {
  ownTeamId: string;
  botUserId: string;
  ownBotId: string;
  botHandle: string;
  ownWorkspaceUrl: string;
  identityMode: SlackIdentityMode;
}

interface UserSnapshot {
  byId: Map<string, CachedUser>;
  fetchedAt: number;
}

interface ChannelRow {
  channelId: string;
  name: string;
  isPrivate?: boolean;
}
interface ChannelMembershipRow {
  channelId: string;
  principalId: string;
}
interface GroupMembershipRow {
  groupId: string;
  principalId: string;
}
interface PrivateChannelRef {
  id: string;
  name: string;
  info: ChannelMeta;
}

type RosterKind = { plural: string; authz: string; item: string };

const MEMBERS_PAGE_LIMIT = 200;
const MAX_CLASSIFY_MEMBERS = 200;

export interface Directory {
  getUserSnapshot(client: any): Promise<{ byId: Map<string, CachedUser>; fetchedAt: number } | undefined>;
  forceDirectorySync(client: any): Promise<void>;
  classifyUserCached(client: any, userId: string): Promise<CachedUser & { ok: boolean }>;
  classifyActor(client: any, userId: string): Promise<ActorAssertion>;
  getChannelInfo(client: any, channel: string): Promise<ChannelMeta | undefined>;
  channelMembership(
    client: any,
    channel: string,
    actor: ActorAssertion,
    actorSlackId: string,
    info: ChannelMeta | undefined,
  ): Promise<{
    audience: ActorAssertion[];
    publishMembers?: ActorAssertion[];
    slackIdsByPrincipal?: Map<string, string>;
  }>;
  allInternalRosters(
    client: any,
    refs: ReadonlyArray<{ id: string; info?: ChannelMeta }>,
    kind: RosterKind,
  ): Promise<Map<string, string[]>>;
  knownPublicChannels: { has(channel: string): boolean; add(channel: string): void; delete(channel: string): void };
  syncForUnseenGroup(client: any, groupId: string): void;
  resolveAutoIdentityMode(client: any): Promise<SlackIdentityMode>;
  maxClassifyMembers: number;
}

export function createDirectory(deps: {
  core: SlackCoreClient;
  ids: BotIdentity;
  userSnapshotTtlMs?: number;
  channelMembersTtlMs?: number;
  maxPrivateChannels?: number;
  userCacheTtlMs?: number;
}): Directory {
  const { core, ids } = deps;
  const USER_SNAPSHOT_TTL_MS = deps.userSnapshotTtlMs ?? 5 * 60_000;
  const CHANNEL_MEMBERS_TTL_MS = deps.channelMembersTtlMs ?? 30 * 60_000;
  const MAX_PRIVATE_CHANNELS = deps.maxPrivateChannels ?? 50;
  const userCache = createUserCache(deps.userCacheTtlMs ? { ttlMs: deps.userCacheTtlMs } : {});

  let userSnapshot: UserSnapshot | undefined;
  let userSnapshotInFlight: Promise<UserSnapshot> | undefined;

  async function refreshUserSnapshot(client: any): Promise<UserSnapshot> {
    const byId = new Map<string, CachedUser>();
    const mentionIndex = new Map<string, string>();
    const ambiguousNames = new Set<string>();
    const indexName = (name: string | undefined, id: string): void => {
      const key = (name ?? "").trim().toLowerCase();
      if (!key || isReservedMentionName(key) || ambiguousNames.has(key)) return;
      const existing = mentionIndex.get(key);
      if (existing && existing !== id) {
        mentionIndex.delete(key);
        ambiguousNames.add(key);
        return;
      }
      mentionIndex.set(key, id);
    };
    let missingEmails = 0;
    for await (const res of client.paginate("users.list", { limit: 1000 }) as AsyncIterable<any>) {
      for (const u of (res.members ?? []) as SlackUser[]) {
        if (!u?.id || u.id === ids.botUserId) continue;
        const actor = classifyUser(u, ids.ownTeamId, ids.identityMode);
        if (ids.identityMode === "email" && !u.is_bot && actor.externalId === u.id && u.team_id === ids.ownTeamId)
          missingEmails++;
        const timezone = slackUserTimezone(u);
        byId.set(u.id, { actor, ...(timezone ? { timezone } : {}) });
        if (!u.deleted) {
          indexName(u.name, u.id);
          indexName(u.profile?.display_name, u.id);
          indexName(u.real_name, u.id);
        }
      }
    }
    setMentionIndex(mentionIndex);
    if (missingEmails > 0) {
      console.warn(
        `[slack] email identity mode: ${missingEmails} own-team member(s) have no visible email (missing users:read.email scope?) — they fail closed to guest`,
      );
    }
    return { byId, fetchedAt: Date.now() };
  }

  async function listBotChannels(
    client: any,
  ): Promise<{ publicChannels: ChannelRow[]; privateChannels: PrivateChannelRef[] }> {
    const publicChannels: ChannelRow[] = [];
    const privateChannels: PrivateChannelRef[] = [];
    for await (const res of client.paginate("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
    }) as AsyncIterable<any>) {
      for (const c of (res.channels ?? []) as Array<{
        id?: string;
        name?: string;
        is_member?: boolean;
        is_private?: boolean;
        is_ext_shared?: boolean;
        is_pending_ext_shared?: boolean;
      }>) {
        if (!c?.id || !c?.name || !c.is_member) continue;
        if (c.is_private) {
          privateChannels.push({
            id: c.id,
            name: c.name,
            info: { is_private: true, is_ext_shared: c.is_ext_shared, is_pending_ext_shared: c.is_pending_ext_shared },
          });
        } else {
          publicChannels.push({ channelId: c.id, name: c.name });
        }
      }
    }
    return { publicChannels, privateChannels };
  }

  async function fetchChannelMemberIds(client: any, channel: string): Promise<{ ids: string[]; complete: boolean }> {
    const memberIds: string[] = [];
    for await (const res of client.paginate("conversations.members", {
      channel,
      limit: MEMBERS_PAGE_LIMIT,
    }) as AsyncIterable<any>) {
      for (const id of res.members ?? []) if (id !== ids.botUserId) memberIds.push(id);
      if (memberIds.length > MAX_CLASSIFY_MEMBERS) return { ids: memberIds, complete: false };
    }
    return { ids: memberIds, complete: true };
  }

  async function allInternalRosters(
    client: any,
    refs: ReadonlyArray<{ id: string; info?: ChannelMeta }>,
    kind: RosterKind,
  ): Promise<Map<string, string[]>> {
    const rosters = new Map<string, string[]>();
    const slice = refs.slice(0, MAX_PRIVATE_CHANNELS);
    if (refs.length > slice.length) {
      console.error(
        `[slack-plugin] ${refs.length} ${kind.plural} exceed the cap (${MAX_PRIVATE_CHANNELS}); ${refs.length - slice.length} omitted from ${kind.authz} authorization`,
      );
    }
    for (const ref of slice) {
      let fetched: { ids: string[]; complete: boolean };
      try {
        fetched = await fetchChannelMemberIds(client, ref.id);
      } catch (err) {
        console.error(`[slack-plugin] members fetch failed for ${kind.item} ${ref.id}:`, (err as Error).message);
        continue;
      }
      const actors: ActorAssertion[] = [];
      let complete = fetched.complete;
      for (const id of fetched.ids) {
        const { actor, ok } = await classifyUserCached(client, id);
        actors.push(actor);
        if (!ok) complete = false;
      }
      const internalIds = allInternalChannelMembers(actors, complete, ref.info);
      if (internalIds) rosters.set(ref.id, internalIds);
    }
    return rosters;
  }

  async function computePrivateChannelMembership(
    client: any,
    privateChannels: PrivateChannelRef[],
  ): Promise<{ channels: ChannelRow[]; channelMembers: ChannelMembershipRow[] }> {
    const channels: ChannelRow[] = [];
    const channelMembers: ChannelMembershipRow[] = [];
    const rosters = await allInternalRosters(client, privateChannels, {
      plural: "private channels",
      authz: "private-channel-send",
      item: "private channel",
    });
    for (const c of privateChannels) {
      const internalIds = rosters.get(c.id);
      if (!internalIds) continue;
      channels.push({ channelId: c.id, name: c.name, isPrivate: true });
      for (const pid of internalIds) channelMembers.push({ channelId: c.id, principalId: pid });
    }
    return { channels, channelMembers };
  }

  async function listBotGroupDms(client: any): Promise<string[]> {
    const groupIds: string[] = [];
    for await (const res of client.paginate("conversations.list", {
      types: "mpim",
      exclude_archived: true,
      limit: 1000,
    }) as AsyncIterable<any>) {
      for (const c of (res.channels ?? []) as Array<{ id?: string; is_member?: boolean }>) {
        if (c?.id && c.is_member) groupIds.push(c.id);
      }
    }
    return groupIds;
  }

  async function computeGroupMembership(client: any, groupIds: string[]): Promise<GroupMembershipRow[]> {
    const groupMembers: GroupMembershipRow[] = [];
    const rosters = await allInternalRosters(
      client,
      groupIds.map((id) => ({ id })),
      { plural: "group DMs", authz: "group-DM-send", item: "group DM" },
    );
    for (const id of groupIds) {
      const internalIds = rosters.get(id);
      if (!internalIds) continue;
      for (const pid of internalIds) groupMembers.push({ groupId: id, principalId: pid });
    }
    return groupMembers;
  }

  let privateChannelsCache:
    | {
        channels: ChannelRow[];
        channelMembers: ChannelMembershipRow[];
        groupMembers?: GroupMembershipRow[];
        fetchedAt: number;
        groupsFetchedAt?: number;
      }
    | undefined;
  let knownPublicChannelSet = new Set<string>();
  const seenGroupIds = new Set<string>();

  async function fetchChannels(client: any): Promise<{
    channels: ChannelRow[];
    channelMembers: ChannelMembershipRow[];
    groupMembers?: GroupMembershipRow[];
    fetchedAt: number;
    groupsFetchedAt?: number;
  } | null> {
    let listed: { publicChannels: ChannelRow[]; privateChannels: PrivateChannelRef[] };
    try {
      listed = await listBotChannels(client);
    } catch (err) {
      console.error("[slack-plugin] channel list failed:", (err as Error).message);
      return null;
    }
    knownPublicChannelSet = new Set(listed.publicChannels.map((channel) => channel.channelId));
    const fresh = privateChannelsCache && Date.now() - privateChannelsCache.fetchedAt < CHANNEL_MEMBERS_TTL_MS;
    if (!fresh) {
      const computed = await computePrivateChannelMembership(client, listed.privateChannels);
      let groupMembers: GroupMembershipRow[] | undefined;
      let groupsFetchedAt: number | undefined;
      try {
        const groupIds = await listBotGroupDms(client);
        for (const id of groupIds) seenGroupIds.add(id);
        groupMembers = await computeGroupMembership(client, groupIds);
        groupsFetchedAt = Date.now();
      } catch (err) {
        console.error("[slack-plugin] group-DM list failed:", (err as Error).message);
        groupMembers = privateChannelsCache?.groupMembers;
        groupsFetchedAt = privateChannelsCache?.groupsFetchedAt;
      }
      privateChannelsCache = { ...computed, groupMembers, groupsFetchedAt, fetchedAt: Date.now() };
    }
    const priv = privateChannelsCache ?? { channels: [], channelMembers: [], fetchedAt: 0 };
    return {
      channels: [...listed.publicChannels, ...priv.channels],
      channelMembers: priv.channelMembers,
      fetchedAt: priv.fetchedAt,
      ...(priv.groupMembers ? { groupMembers: priv.groupMembers, groupsFetchedAt: priv.groupsFetchedAt } : {}),
    };
  }

  async function pushDirectory(snap: UserSnapshot, client: any): Promise<void> {
    const members = [...snap.byId.entries()]
      .filter(([, u]) => !u.actor.isExternalGuest)
      .map(([slackId, u]) => {
        const a = u.actor;
        return {
          principalId: a.externalId,
          displayName: a.displayName ?? a.externalId,
          type: "internal" as const,
          ...(slackId && slackId !== a.externalId ? { slackId } : {}),
        };
      });
    const fetched = await fetchChannels(client);
    if (!members.length && !(fetched && fetched.channels.length)) return;
    try {
      await core.pushDirectory({
        members,
        membersSyncedAt: snap.fetchedAt,
        ...(fetched
          ? {
              channels: fetched.channels,
              channelMembers: fetched.channelMembers,
              channelsSyncedAt: fetched.fetchedAt,
              ...(fetched.groupMembers
                ? { groupMembers: fetched.groupMembers, groupsSyncedAt: fetched.groupsFetchedAt }
                : {}),
            }
          : {}),
        ...(ids.ownWorkspaceUrl ? { workspaceUrl: ids.ownWorkspaceUrl } : {}),
      });
    } catch (err) {
      console.error("[slack-plugin] directory push failed:", (err as Error).message);
    }
  }

  async function getUserSnapshot(client: any): Promise<UserSnapshot | undefined> {
    if (!ids.ownTeamId) return undefined;
    const snap = userSnapshot;
    const stale = !snap || Date.now() - snap.fetchedAt >= USER_SNAPSHOT_TTL_MS;
    if (stale && !userSnapshotInFlight) {
      userSnapshotInFlight = refreshUserSnapshot(client)
        .then((s) => {
          userSnapshot = s;
          void pushDirectory(s, client);
          return s;
        })
        .finally(() => {
          userSnapshotInFlight = undefined;
        });
      userSnapshotInFlight.catch(swallowAs("slack: user snapshot refresh", undefined));
    }
    if (snap) return snap;
    try {
      return await userSnapshotInFlight;
    } catch {
      return undefined;
    }
  }

  let directorySyncClient: any;
  const coalescedDirectorySync = createRefreshCoalescer(async () => {
    privateChannelsCache = undefined;
    const snap = userSnapshot ?? (await getUserSnapshot(directorySyncClient));
    if (snap) await pushDirectory(snap, directorySyncClient);
  });

  function forceDirectorySync(client: any): Promise<void> {
    directorySyncClient = client;
    return coalescedDirectorySync();
  }

  function syncForUnseenGroup(client: any, groupId: string): void {
    if (seenGroupIds.has(groupId)) return;
    seenGroupIds.add(groupId);
    void forceDirectorySync(client).catch(swallowAs("slack: unseen group-DM directory sync", undefined));
  }

  async function classifyUserCached(client: any, userId: string): Promise<CachedUser & { ok: boolean }> {
    const cached = userCache.get(userId);
    if (cached) return { ...cached, ok: true };
    const snapshot = await getUserSnapshot(client);
    const fromSnapshot = snapshot?.byId.get(userId);
    if (fromSnapshot) return { ...fromSnapshot, ok: true };
    try {
      const user = (await client.users.info({ user: userId })).user as SlackUser | undefined;
      const actor = classifyUser(user, ids.ownTeamId, ids.identityMode);
      const timezone = slackUserTimezone(user);
      const classified = { actor, ...(timezone ? { timezone } : {}) };
      if (ids.ownTeamId) userCache.set(userId, classified);
      return { ...classified, ok: true };
    } catch {
      return { actor: { externalId: userId, isExternalGuest: true }, ok: false };
    }
  }

  async function classifyActor(client: any, userId: string): Promise<ActorAssertion> {
    return (await classifyUserCached(client, userId)).actor;
  }

  async function getChannelInfo(client: any, channel: string): Promise<ChannelMeta | undefined> {
    try {
      return (await client.conversations.info({ channel })).channel as ChannelMeta;
    } catch {
      return undefined;
    }
  }

  async function channelMembership(
    client: any,
    channel: string,
    actor: ActorAssertion,
    actorSlackId: string,
    info: ChannelMeta | undefined,
  ): Promise<{
    audience: ActorAssertion[];
    publishMembers?: ActorAssertion[];
    slackIdsByPrincipal?: Map<string, string>;
  }> {
    try {
      const { ids: memberIds } = await fetchChannelMemberIds(client, channel);
      return await resolveChannelMembership({
        memberIds,
        actor,
        actorSlackId,
        info,
        maxClassifyMembers: MAX_CLASSIFY_MEMBERS,
        classify: (id) => classifyUserCached(client, id),
      });
    } catch {
      return { audience: [actor, externalMarker()] };
    }
  }

  async function resolveAutoIdentityMode(client: any): Promise<SlackIdentityMode> {
    for (let attempt = 1; ; attempt++) {
      try {
        let sawOwnTeamHuman = false;
        for await (const res of client.paginate("users.list", { limit: 1000 }) as AsyncIterable<{
          members?: SlackUser[];
        }>) {
          const evidence = probeIdentityMode(res.members ?? [], ids.ownTeamId);
          if (evidence === "email") return "email";
          if (evidence === "slack-id") sawOwnTeamHuman = true;
        }
        return sawOwnTeamHuman ? "slack-id" : "email";
      } catch (err) {
        if (attempt >= 3) {
          throw new Error(
            `identity-mode probe failed after ${attempt} attempts (${errMessage(err)}) — refusing to start rather than guess the principal keying; set SLACK_IDENTITY_EMAIL=1 or =0 to skip the probe`,
            { cause: err },
          );
        }
        await sleep(attempt * 2000);
      }
    }
  }

  return {
    getUserSnapshot,
    forceDirectorySync,
    classifyUserCached,
    classifyActor,
    getChannelInfo,
    channelMembership,
    allInternalRosters,
    knownPublicChannels: {
      has: (channel: string) => knownPublicChannelSet.has(channel),
      add: (channel: string) => void knownPublicChannelSet.add(channel),
      delete: (channel: string) => void knownPublicChannelSet.delete(channel),
    },
    syncForUnseenGroup,
    resolveAutoIdentityMode,
    maxClassifyMembers: MAX_CLASSIFY_MEMBERS,
  };
}
