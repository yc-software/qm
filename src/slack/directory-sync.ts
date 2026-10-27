import type { BotIdentity, UserDirectory, UserSnapshot } from "./directory.ts";
import {
  type ActorAssertion,
  type CachedUser,
  type ChannelMeta,
  allInternalChannelMembers,
  internalChannelMembers,
  isExternallyShared,
} from "./identity.ts";
import { createRefreshCoalescer } from "./message-gating.ts";
import { reportFailure, swallowAs } from "../util/errors.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";

export type RosterRef = { id: string; info?: ChannelMeta };
export type RosterKind = { plural: string; authz: string; item: string; limit?: number; requireComplete?: boolean };
type ClassifiedRoster = { actors: ActorAssertion[]; complete: boolean };
export interface RosterReader {
  ids: { botUserId: string };
  classifyUserCached: (client: any, userId: string | undefined) => Promise<CachedUser & { ok: boolean }>;
}

const MEMBERS_PAGE_LIMIT = 200;
const ROSTER_FETCH_CONCURRENCY = 4;

async function listBotConversations(client: any, types: string): Promise<Array<ChannelMeta & { id: string }>> {
  const out: Array<ChannelMeta & { id: string }> = [];
  for await (const res of client.paginate("conversations.list", {
    types,
    exclude_archived: true,
    limit: 1000,
  }) as AsyncIterable<any>) {
    for (const c of res.channels ?? []) if (c?.id && c.is_member) out.push(c);
  }
  return out;
}

export async function fetchChannelMemberIds(client: any, botUserId: string, channel: string): Promise<string[]> {
  const memberIds: string[] = [];
  for await (const res of client.paginate("conversations.members", {
    channel,
    limit: MEMBERS_PAGE_LIMIT,
  }) as AsyncIterable<any>) {
    for (const id of res.members ?? []) if (id !== botUserId) memberIds.push(id);
  }
  return memberIds;
}

async function allClassifiedRosters(
  reader: RosterReader,
  client: any,
  refs: ReadonlyArray<RosterRef>,
  kind: RosterKind,
): Promise<Map<string, ClassifiedRoster>> {
  const rosters = new Map<string, ClassifiedRoster>();
  const limit = kind.limit ?? Infinity;
  const queue = refs.slice(0, limit);
  if (refs.length > queue.length) {
    console.error(
      `[slack-plugin] ${refs.length} ${kind.plural} exceed the cap (${limit}); ${refs.length - queue.length} omitted from ${kind.authz} authorization`,
    );
  }
  await Promise.all(
    Array.from({ length: Math.min(ROSTER_FETCH_CONCURRENCY, queue.length) }, async () => {
      for (let ref = queue.pop(); ref; ref = queue.pop()) {
        let memberIds: string[];
        try {
          memberIds = await fetchChannelMemberIds(client, reader.ids.botUserId, ref.id);
        } catch (err) {
          if (kind.requireComplete) throw err;
          reportFailure(`slack: ${kind.item} members fetch`, err, ref.id);
          continue;
        }
        const actors: ActorAssertion[] = [];
        let complete = true;
        for (const id of memberIds) {
          const { actor, ok } = await reader.classifyUserCached(client, id);
          actors.push(actor);
          if (!ok) {
            if (kind.requireComplete) throw new Error("Slack mirror member classification unavailable");
            complete = false;
          }
        }
        rosters.set(ref.id, { actors, complete });
      }
    }),
  );
  return rosters;
}

export async function allInternalRosters(
  reader: RosterReader,
  client: any,
  refs: ReadonlyArray<RosterRef>,
  kind: RosterKind,
): Promise<Map<string, string[]>> {
  const classified = await allClassifiedRosters(reader, client, refs, kind);
  const rosters = new Map<string, string[]>();
  for (const ref of refs) {
    const roster = classified.get(ref.id);
    const internalIds = roster && allInternalChannelMembers(roster.actors, roster.complete, ref.info);
    if (internalIds) rosters.set(ref.id, internalIds);
  }
  return rosters;
}

type ChannelInvalidations = ReadonlyMap<string, ReadonlySet<string>>;

export interface DirectorySyncContext extends RosterReader {
  core: SlackCoreClient;
  ids: BotIdentity;
  coreSingleton: boolean;
  lastFullRosterFetchAt?: number;
  seenGroupIds: Set<string>;
  expireUserSnapshot: () => void;
}

const CHANNEL_MEMBERS_TTL_MS = 30 * 60_000;

async function fetchGroups(ctx: DirectorySyncContext, client: any) {
  try {
    const groupsSyncedAt = Date.now();
    const groupIds = (await listBotConversations(client, "mpim")).map((c) => c.id);
    for (const id of groupIds) ctx.seenGroupIds.add(id);
    const groupRosters = await allInternalRosters(
      ctx,
      client,
      groupIds.map((id) => ({ id })),
      { plural: "group DMs", authz: "group-DM-send", item: "group DM", limit: groupIds.length },
    );
    const groupMembers = groupIds.flatMap((groupId) =>
      (groupRosters.get(groupId) ?? []).map((principalId) => ({ groupId, principalId })),
    );
    return { groupMembers, groupIds, groupRosterIds: [...groupRosters.keys()], groupsSyncedAt };
  } catch (err) {
    reportFailure("slack: group-DM list", err);
    return {};
  }
}

async function fetchChannels(
  ctx: DirectorySyncContext,
  client: any,
  invalidations: ChannelInvalidations,
  targetChannelIds?: ReadonlySet<string>,
) {
  const fetchedAt = Date.now();
  let listed: Array<ChannelMeta & { id: string; name: string }>;
  try {
    const all = (await listBotConversations(client, "public_channel,private_channel")).filter(
      (c): c is ChannelMeta & { id: string; name: string } => Boolean(c.name),
    );
    listed = [...all.filter((c) => !c.is_private), ...all.filter((c) => c.is_private)];
  } catch (err) {
    reportFailure("slack: channel list", err);
    return null;
  }
  const channels = listed.map((c) => ({
    channelId: c.id,
    name: c.name,
    ...(c.is_private ? { isPrivate: true } : {}),
    ...(isExternallyShared(c) ? { isExternal: true } : {}),
  }));
  const fullRefresh =
    !targetChannelIds?.size &&
    (ctx.lastFullRosterFetchAt === undefined || fetchedAt - ctx.lastFullRosterFetchAt >= CHANNEL_MEMBERS_TTL_MS);
  const refs = listed.filter((c) => fullRefresh || targetChannelIds?.has(c.id));
  const rosters = await allClassifiedRosters(ctx, client, refs, {
    plural: "channels",
    authz: "channel",
    item: "channel",
  });
  const channelMembers: Array<{ channelId: string; principalId: string }> = [];
  const channelRosterIds: string[] = [];
  for (const { id: channelId } of refs) {
    const roster = rosters.get(channelId);
    const internalIds = roster && internalChannelMembers(roster.actors, roster.complete);
    if (!internalIds) continue;
    channelRosterIds.push(channelId);
    const revoked = invalidations.get(channelId);
    for (const principalId of internalIds)
      if (!revoked?.has(principalId)) channelMembers.push({ channelId, principalId });
  }
  const channelRevocations = [...invalidations].flatMap(([channelId, principalIds]) =>
    [...principalIds].map((principalId) => ({ channelId, principalId })),
  );
  const groups = fullRefresh ? await fetchGroups(ctx, client) : {};
  return {
    push: { channels, channelMembers, channelRosterIds, channelRevocations, channelsSyncedAt: fetchedAt, ...groups },
    fullRosterFetchedAt: fullRefresh ? fetchedAt : undefined,
  };
}

async function crawlAndPush(
  ctx: DirectorySyncContext,
  snap: UserSnapshot,
  client: any,
  invalidations: ChannelInvalidations,
  leaseLost: () => boolean,
  targetChannelIds?: ReadonlySet<string>,
): Promise<boolean> {
  const members = [...snap.byId.entries()]
    .filter(([, u]) => !u.actor.isExternalGuest)
    .map(([slackId, { actor: a, avatarUrl }]) => ({
      principalId: a.externalId,
      displayName: a.displayName ?? a.externalId,
      type: "internal" as const,
      ...(slackId && slackId !== a.externalId ? { slackId } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    }));
  const fetched = await fetchChannels(ctx, client, invalidations, targetChannelIds);
  if (leaseLost()) {
    console.error("[slack-plugin] directory sync lease lost mid-crawl — discarding the crawl");
    return false;
  }
  if (!members.length && !fetched?.push.channels.length) return false;
  try {
    const applied = await ctx.core.pushDirectory({
      members,
      membersSyncedAt: snap.fetchedAt,
      ...fetched?.push,
      ...(ctx.ids.ownWorkspaceUrl ? { workspaceUrl: ctx.ids.ownWorkspaceUrl } : {}),
    });
    if (applied && fetched?.fullRosterFetchedAt !== undefined) ctx.lastFullRosterFetchAt = fetched.fullRosterFetchedAt;
    if (!applied) ctx.expireUserSnapshot();
    return fetched !== null && applied;
  } catch (err) {
    reportFailure("slack: directory push", err);
    return false;
  }
}

export async function pushDirectory(
  ctx: DirectorySyncContext,
  snap: UserSnapshot,
  client: any,
  invalidations: ChannelInvalidations = new Map(),
  targetChannelIds?: ReadonlySet<string>,
): Promise<boolean> {
  if (!ctx.coreSingleton) return true;
  let pushed: boolean | null;
  try {
    pushed = await ctx.core.holdDirectorySync(async (lost) => {
      let lostFlag = false;
      void lost.then(() => {
        lostFlag = true;
      });
      return crawlAndPush(ctx, snap, client, invalidations, () => lostFlag, targetChannelIds);
    });
  } catch (err) {
    reportFailure("slack: directory sync lease", err);
    return false;
  }
  if (pushed === null) console.log("[slack-plugin] directory sync skipped: the sync lease is held elsewhere");
  return pushed ?? false;
}

export function createDirectorySync(ctx: DirectorySyncContext, users: UserDirectory, syncRetryMs: number) {
  let directorySyncClient: any;
  const invalidatedChannelMembers = new Map<string, Set<string>>();
  const targetedChannelIds = new Set<string>();
  let fullDirectorySyncRequested = false;
  let syncRetryTimer: NodeJS.Timeout | undefined;
  function scheduleSyncRetry(): void {
    if (syncRetryTimer) return;
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = undefined;
      void coalescedDirectorySync().catch(swallowAs("slack: directory sync retry", undefined));
    }, syncRetryMs);
    syncRetryTimer.unref?.();
  }
  const coalescedDirectorySync = createRefreshCoalescer(async () => {
    const fullSync = fullDirectorySyncRequested;
    fullDirectorySyncRequested = false;
    const scheduledTargets = new Set(targetedChannelIds);
    const targets = fullSync || !scheduledTargets.size ? undefined : scheduledTargets;
    if (!targets) ctx.lastFullRosterFetchAt = undefined;
    const snap = users.current() ?? (await users.getUserSnapshot(directorySyncClient));
    const pendingInvalidations = new Map(
      [...invalidatedChannelMembers].map(([channelId, principalIds]) => [channelId, new Set(principalIds)]),
    );
    if (snap && (await pushDirectory(ctx, snap, directorySyncClient, pendingInvalidations, targets))) {
      for (const channelId of scheduledTargets) targetedChannelIds.delete(channelId);
      for (const [channelId, principalIds] of pendingInvalidations) {
        const current = invalidatedChannelMembers.get(channelId);
        for (const principalId of principalIds) current?.delete(principalId);
        if (!current?.size) invalidatedChannelMembers.delete(channelId);
      }
    } else {
      if (fullSync) fullDirectorySyncRequested = true;
      if (fullDirectorySyncRequested || targetedChannelIds.size || invalidatedChannelMembers.size) scheduleSyncRetry();
    }
  });

  async function forceDirectorySync(
    client: any,
    invalidateChannelId?: string,
    invalidatePrincipalId?: string,
  ): Promise<void> {
    directorySyncClient = client;
    if (!invalidateChannelId) fullDirectorySyncRequested = true;
    else {
      if (invalidatePrincipalId) {
        const principals = invalidatedChannelMembers.get(invalidateChannelId) ?? new Set<string>();
        principals.add(invalidatePrincipalId);
        invalidatedChannelMembers.set(invalidateChannelId, principals);
      }
      targetedChannelIds.add(invalidateChannelId);
    }
    await coalescedDirectorySync();
    if (
      invalidateChannelId &&
      invalidatePrincipalId &&
      invalidatedChannelMembers.get(invalidateChannelId)?.has(invalidatePrincipalId)
    )
      throw new Error("Slack channel membership revocation was not persisted");
  }

  function syncForUnseenGroup(client: any, groupId: string): void {
    if (ctx.seenGroupIds.has(groupId)) return;
    ctx.seenGroupIds.add(groupId);
    void forceDirectorySync(client).catch(swallowAs("slack: unseen group-DM directory sync", undefined));
  }

  return { forceDirectorySync, syncForUnseenGroup };
}
