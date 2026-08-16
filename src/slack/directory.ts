import {
  type ActorAssertion,
  type CachedUser,
  type ChannelMeta,
  type SlackIdentityMode,
  type SlackUser,
  allInternalChannelMembers,
  internalChannelMembers,
  classifyUser,
  createRefreshCoalescer,
  createUserCache,
  externalMarker,
  isExternallyShared,
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
  isExternal?: boolean;
}
interface ChannelMembershipRow {
  channelId: string;
  principalId: string;
}
type ChannelInvalidations = ReadonlyMap<string, ReadonlySet<string>>;
interface GroupMembershipRow {
  groupId: string;
  principalId: string;
}
interface ChannelRef {
  id: string;
  name: string;
  info: ChannelMeta;
}

type RosterKind = { plural: string; authz: string; item: string; limit?: number };

const MEMBERS_PAGE_LIMIT = 200;
const ROSTER_FETCH_CONCURRENCY = 4;

export interface Directory {
  getUserSnapshot(client: any): Promise<{ byId: Map<string, CachedUser>; fetchedAt: number } | undefined>;
  forceDirectorySync(client: any, invalidateChannelId?: string, invalidatePrincipalId?: string): Promise<void>;
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
  syncForUnseenGroup(client: any, groupId: string): void;
  resolveAutoIdentityMode(client: any): Promise<SlackIdentityMode>;
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
  const MAX_PRIVATE_CHANNELS = deps.maxPrivateChannels ?? Infinity;
  const userCache = createUserCache(deps.userCacheTtlMs ? { ttlMs: deps.userCacheTtlMs } : {});

  let userSnapshot: UserSnapshot | undefined;
  let userSnapshotInFlight: Promise<UserSnapshot> | undefined;

  async function refreshUserSnapshot(client: any): Promise<UserSnapshot> {
    const fetchedAt = Date.now();
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
    return { byId, fetchedAt };
  }

  async function listBotChannels(
    client: any,
  ): Promise<{ publicChannels: ChannelRef[]; privateChannels: ChannelRef[] }> {
    const publicChannels: ChannelRef[] = [];
    const privateChannels: ChannelRef[] = [];
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
          publicChannels.push({
            id: c.id,
            name: c.name,
            info: { is_private: false, is_ext_shared: c.is_ext_shared, is_pending_ext_shared: c.is_pending_ext_shared },
          });
        }
      }
    }
    return { publicChannels, privateChannels };
  }

  async function fetchChannelMemberIds(client: any, channel: string): Promise<string[]> {
    const memberIds: string[] = [];
    for await (const res of client.paginate("conversations.members", {
      channel,
      limit: MEMBERS_PAGE_LIMIT,
    }) as AsyncIterable<any>) {
      for (const id of res.members ?? []) if (id !== ids.botUserId) memberIds.push(id);
    }
    return memberIds;
  }

  async function allInternalRosters(
    client: any,
    refs: ReadonlyArray<{ id: string; info?: ChannelMeta }>,
    kind: RosterKind,
  ): Promise<Map<string, string[]>> {
    const classified = await allClassifiedRosters(client, refs, kind);
    const rosters = new Map<string, string[]>();
    for (const ref of refs) {
      const roster = classified.get(ref.id);
      if (!roster) continue;
      const internalIds = allInternalChannelMembers(roster.actors, roster.complete, ref.info);
      if (internalIds) rosters.set(ref.id, internalIds);
    }
    return rosters;
  }

  async function allClassifiedRosters(
    client: any,
    refs: ReadonlyArray<{ id: string; info?: ChannelMeta }>,
    kind: RosterKind,
  ): Promise<Map<string, { actors: ActorAssertion[]; complete: boolean }>> {
    const rosters = new Map<string, { actors: ActorAssertion[]; complete: boolean }>();
    const limit = kind.limit ?? Infinity;
    const slice = refs.slice(0, limit);
    if (refs.length > slice.length) {
      console.error(
        `[slack-plugin] ${refs.length} ${kind.plural} exceed the cap (${limit}); ${refs.length - slice.length} omitted from ${kind.authz} authorization`,
      );
    }
    const queue = [...slice];
    await Promise.all(
      Array.from({ length: Math.min(ROSTER_FETCH_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const ref = queue.pop();
          if (!ref) return;
          let memberIds: string[];
          try {
            memberIds = await fetchChannelMemberIds(client, ref.id);
          } catch (err) {
            console.error(`[slack-plugin] members fetch failed for ${kind.item} ${ref.id}:`, (err as Error).message);
            continue;
          }
          const actors: ActorAssertion[] = [];
          let complete = true;
          for (const id of memberIds) {
            const { actor, ok } = await classifyUserCached(client, id);
            actors.push(actor);
            if (!ok) complete = false;
          }
          rosters.set(ref.id, { actors, complete });
        }
      }),
    );
    return rosters;
  }

  async function computeChannelMembership(
    client: any,
    publicChannels: ChannelRef[],
    privateChannels: ChannelRef[],
    invalidations: ChannelInvalidations,
  ): Promise<{
    channels: ChannelRow[];
    channelMembers: ChannelMembershipRow[];
    channelRosterIds: string[];
    channelRevocations: ChannelMembershipRow[];
  }> {
    const refs = [...publicChannels, ...privateChannels];
    const channels = refs.map((channel) => ({
      channelId: channel.id,
      name: channel.name,
      ...(channel.info.is_private ? { isPrivate: true } : {}),
      ...(isExternallyShared(channel.info) ? { isExternal: true } : {}),
    }));
    const channelMembers: ChannelMembershipRow[] = [];
    const channelRosterIds: string[] = [];
    const channelRevocations = [...invalidations].flatMap(([channelId, principalIds]) =>
      [...principalIds].map((principalId) => ({ channelId, principalId })),
    );
    const rosters = await allClassifiedRosters(client, refs, {
      plural: "channels",
      authz: "channel",
      item: "channel",
      limit: publicChannels.length + Math.min(privateChannels.length, MAX_PRIVATE_CHANNELS),
    });
    for (const channel of refs) {
      const roster = rosters.get(channel.id);
      const internalIds = roster && internalChannelMembers(roster.actors, roster.complete);
      if (!internalIds) continue;
      const revoked = invalidations.get(channel.id);
      channelRosterIds.push(channel.id);
      for (const principalId of internalIds) {
        if (!revoked?.has(principalId)) channelMembers.push({ channelId: channel.id, principalId });
      }
    }
    return { channels, channelMembers, channelRosterIds, channelRevocations };
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

  async function computeGroupMembership(
    client: any,
    groupIds: string[],
  ): Promise<{ groupMembers: GroupMembershipRow[]; groupRosterIds: string[] }> {
    const groupMembers: GroupMembershipRow[] = [];
    const rosters = await allInternalRosters(
      client,
      groupIds.map((id) => ({ id })),
      { plural: "group DMs", authz: "group-DM-send", item: "group DM", limit: groupIds.length },
    );
    for (const id of groupIds) {
      const internalIds = rosters.get(id);
      if (!internalIds) continue;
      for (const pid of internalIds) groupMembers.push({ groupId: id, principalId: pid });
    }
    return { groupMembers, groupRosterIds: [...rosters.keys()] };
  }

  let privateChannelsCache:
    | {
        channels: ChannelRow[];
        channelMembers: ChannelMembershipRow[];
        channelRosterIds: string[];
        channelRevocations: ChannelMembershipRow[];
        groupMembers?: GroupMembershipRow[];
        groupIds?: string[];
        groupRosterIds?: string[];
        fetchedAt: number;
        groupsFetchedAt?: number;
      }
    | undefined;
  const seenGroupIds = new Set<string>();

  async function fetchChannels(
    client: any,
    invalidations: ChannelInvalidations,
    targetChannelIds?: ReadonlySet<string>,
  ): Promise<{
    channels: ChannelRow[];
    channelMembers: ChannelMembershipRow[];
    channelRosterIds: string[];
    channelRevocations: ChannelMembershipRow[];
    groupMembers?: GroupMembershipRow[];
    groupIds?: string[];
    groupRosterIds?: string[];
    fetchedAt: number;
    groupsFetchedAt?: number;
  } | null> {
    const fetchedAt = Date.now();
    let listed: { publicChannels: ChannelRef[]; privateChannels: ChannelRef[] };
    try {
      listed = await listBotChannels(client);
    } catch (err) {
      console.error("[slack-plugin] channel list failed:", (err as Error).message);
      return null;
    }
    const listedChannels = [...listed.publicChannels, ...listed.privateChannels];
    if (targetChannelIds?.size) {
      const computed = await computeChannelMembership(
        client,
        listed.publicChannels.filter((channel) => targetChannelIds.has(channel.id)),
        listed.privateChannels.filter((channel) => targetChannelIds.has(channel.id)),
        invalidations,
      );
      const channels = listedChannels.map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        ...(channel.info.is_private ? { isPrivate: true } : {}),
        ...(isExternallyShared(channel.info) ? { isExternal: true } : {}),
      }));
      if (privateChannelsCache) {
        const refreshed = new Set(computed.channelRosterIds);
        privateChannelsCache.channels = channels;
        privateChannelsCache.channelMembers = [
          ...privateChannelsCache.channelMembers.filter(
            (member) =>
              !refreshed.has(member.channelId) && !invalidations.get(member.channelId)?.has(member.principalId),
          ),
          ...computed.channelMembers,
        ];
        privateChannelsCache.channelRosterIds = [
          ...new Set([...privateChannelsCache.channelRosterIds, ...computed.channelRosterIds]),
        ];
      }
      return { ...computed, channels, fetchedAt };
    }
    const fresh = privateChannelsCache && Date.now() - privateChannelsCache.fetchedAt < CHANNEL_MEMBERS_TTL_MS;
    let includeGroups = true;
    if (!fresh) {
      const computed = await computeChannelMembership(
        client,
        listed.publicChannels,
        listed.privateChannels,
        invalidations,
      );
      let groupMembers: GroupMembershipRow[] | undefined;
      let groupIds: string[] | undefined;
      let groupRosterIds: string[] | undefined;
      let groupsFetchedAt: number | undefined;
      try {
        groupsFetchedAt = Date.now();
        groupIds = await listBotGroupDms(client);
        for (const id of groupIds) seenGroupIds.add(id);
        const computedGroups = await computeGroupMembership(client, groupIds);
        groupMembers = computedGroups.groupMembers;
        groupRosterIds = computedGroups.groupRosterIds;
      } catch (err) {
        console.error("[slack-plugin] group-DM list failed:", (err as Error).message);
        includeGroups = false;
        groupMembers = privateChannelsCache?.groupMembers;
        groupIds = privateChannelsCache?.groupIds;
        groupRosterIds = privateChannelsCache?.groupRosterIds;
        groupsFetchedAt = privateChannelsCache?.groupsFetchedAt;
      }
      privateChannelsCache = {
        ...computed,
        groupMembers,
        groupIds,
        groupRosterIds,
        groupsFetchedAt,
        fetchedAt,
      };
    }
    const priv = privateChannelsCache ?? {
      channels: [],
      channelMembers: [],
      channelRosterIds: [],
      channelRevocations: [],
      fetchedAt: 0,
    };
    return {
      channels: priv.channels,
      channelMembers: priv.channelMembers,
      channelRosterIds: priv.channelRosterIds,
      channelRevocations: priv.channelRevocations,
      fetchedAt: priv.fetchedAt,
      ...(includeGroups && priv.groupMembers
        ? {
            groupMembers: priv.groupMembers,
            groupIds: priv.groupIds,
            groupRosterIds: priv.groupRosterIds,
            groupsFetchedAt: priv.groupsFetchedAt,
          }
        : {}),
    };
  }

  async function pushDirectory(
    snap: UserSnapshot,
    client: any,
    invalidations: ChannelInvalidations = new Map(),
    targetChannelIds?: ReadonlySet<string>,
  ): Promise<boolean> {
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
    const fetched = await fetchChannels(client, invalidations, targetChannelIds);
    if (!members.length && !(fetched && fetched.channels.length)) return false;
    try {
      await core.pushDirectory({
        members,
        membersSyncedAt: snap.fetchedAt,
        ...(fetched
          ? {
              channels: fetched.channels,
              channelMembers: fetched.channelMembers,
              channelRosterIds: fetched.channelRosterIds,
              channelRevocations: fetched.channelRevocations,
              channelsSyncedAt: fetched.fetchedAt,
              ...(fetched.groupMembers
                ? {
                    groupMembers: fetched.groupMembers,
                    groupIds: fetched.groupIds,
                    groupRosterIds: fetched.groupRosterIds,
                    groupsSyncedAt: fetched.groupsFetchedAt,
                  }
                : {}),
            }
          : {}),
        ...(ids.ownWorkspaceUrl ? { workspaceUrl: ids.ownWorkspaceUrl } : {}),
      });
      return fetched !== null;
    } catch (err) {
      console.error("[slack-plugin] directory push failed:", (err as Error).message);
      return false;
    }
  }

  async function getUserSnapshot(client: any): Promise<UserSnapshot | undefined> {
    if (!ids.ownTeamId) return undefined;
    const snap = userSnapshot;
    const stale = !snap || Date.now() - snap.fetchedAt >= USER_SNAPSHOT_TTL_MS;
    if (stale && !userSnapshotInFlight) {
      userSnapshotInFlight = refreshUserSnapshot(client)
        .then(async (s) => {
          userSnapshot = s;
          await pushDirectory(s, client);
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
  const invalidatedChannelMembers = new Map<string, Set<string>>();
  const targetedChannelIds = new Set<string>();
  let fullDirectorySyncRequested = false;
  const coalescedDirectorySync = createRefreshCoalescer(async () => {
    const fullSync = fullDirectorySyncRequested;
    fullDirectorySyncRequested = false;
    const scheduledTargets = new Set(targetedChannelIds);
    const targets = fullSync || !scheduledTargets.size ? undefined : scheduledTargets;
    if (!targets && privateChannelsCache) privateChannelsCache.fetchedAt = 0;
    const snap = userSnapshot ?? (await getUserSnapshot(directorySyncClient));
    const pendingInvalidations = new Map(
      [...invalidatedChannelMembers].map(([channelId, principalIds]) => [channelId, new Set(principalIds)]),
    );
    if (snap && (await pushDirectory(snap, directorySyncClient, pendingInvalidations, targets))) {
      if (privateChannelsCache) privateChannelsCache.channelRevocations = [];
      for (const channelId of scheduledTargets) targetedChannelIds.delete(channelId);
      for (const [channelId, principalIds] of pendingInvalidations) {
        const current = invalidatedChannelMembers.get(channelId);
        for (const principalId of principalIds) current?.delete(principalId);
        if (!current?.size) invalidatedChannelMembers.delete(channelId);
      }
    } else if (fullSync) {
      fullDirectorySyncRequested = true;
    }
  });

  function forceDirectorySync(
    client: any,
    invalidateChannelId?: string,
    invalidatePrincipalId?: string,
  ): Promise<void> {
    directorySyncClient = client;
    if (!invalidateChannelId) fullDirectorySyncRequested = true;
    if (invalidateChannelId && invalidatePrincipalId) {
      const principals = invalidatedChannelMembers.get(invalidateChannelId) ?? new Set<string>();
      principals.add(invalidatePrincipalId);
      invalidatedChannelMembers.set(invalidateChannelId, principals);
    }
    if (invalidateChannelId) targetedChannelIds.add(invalidateChannelId);
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
      const memberIds = await fetchChannelMemberIds(client, channel);
      return await resolveChannelMembership({
        memberIds,
        actor,
        actorSlackId,
        info,
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
    syncForUnseenGroup,
    resolveAutoIdentityMode,
  };
}
