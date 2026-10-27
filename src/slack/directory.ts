import { companySlackActor, type ExternalSlackAccess } from "./external-access.ts";
import {
  allInternalRosters,
  createDirectorySync,
  fetchChannelMemberIds,
  pushDirectory,
  type DirectorySyncContext,
  type RosterKind,
  type RosterRef,
} from "./directory-sync.ts";
import {
  type ActorAssertion,
  type CachedUser,
  type ChannelMembership,
  type ChannelMeta,
  type SlackIdentityMode,
  type SlackUser,
  classifyUser,
  createUserCache,
  externalMarker,
  probeIdentityMode,
  resolveChannelMembership,
  slackUserTimezone,
} from "./identity.ts";
import { isReservedMentionName, setMentionIndex } from "./mrkdwn.ts";
import { sleep } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";

export interface BotIdentity {
  ownTeamId: string;
  botUserId: string;
  ownBotId: string;
  botHandle: string;
  ownWorkspaceUrl: string;
  identityMode: SlackIdentityMode;
}

export interface UserSnapshot {
  byId: Map<string, CachedUser>;
  fetchedAt: number;
}

interface UserDirectoryDeps {
  ids: BotIdentity;
  coreSingleton: boolean;
  classify: (u: SlackUser | undefined) => ActorAssertion;
  onRefreshed: (snapshot: UserSnapshot, client: any) => Promise<unknown>;
}

const USER_SNAPSHOT_TTL_MS = 5 * 60_000;

async function refreshUserSnapshot(deps: UserDirectoryDeps, client: any): Promise<UserSnapshot> {
  const { ids } = deps;
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
      const actor = deps.classify(u);
      if (ids.identityMode === "email" && !u.is_bot && actor.externalId === u.id && u.team_id === ids.ownTeamId)
        missingEmails++;
      const timezone = slackUserTimezone(u);
      const avatarUrl = u.profile?.image_72;
      byId.set(u.id, { actor, ...(timezone ? { timezone } : {}), ...(avatarUrl ? { avatarUrl } : {}) });
      if (!u.deleted) for (const name of [u.name, u.profile?.display_name, u.real_name]) indexName(name, u.id);
    }
  }
  if (deps.coreSingleton) setMentionIndex(mentionIndex);
  if (missingEmails > 0) {
    console.warn(
      `[slack] email identity mode: ${missingEmails} own-team member(s) have no visible email (missing users:read.email scope?) — they fail closed to guest`,
    );
  }
  return { byId, fetchedAt };
}

function createUserDirectory(deps: UserDirectoryDeps) {
  const { ids } = deps;
  const userCache = createUserCache();
  let snapshot: UserSnapshot | undefined;
  let inFlight: Promise<UserSnapshot> | undefined;

  async function getUserSnapshot(client: any): Promise<UserSnapshot | undefined> {
    if (!ids.ownTeamId) return undefined;
    const snap = snapshot;
    const stale = !snap || Date.now() - snap.fetchedAt >= USER_SNAPSHOT_TTL_MS;
    if (stale && !inFlight) {
      inFlight = refreshUserSnapshot(deps, client)
        .then(async (s) => {
          snapshot = s;
          await deps.onRefreshed(s, client);
          return s;
        })
        .finally(() => {
          inFlight = undefined;
        });
      inFlight.catch(swallowAs("slack: user snapshot refresh", undefined));
    }
    return snap ?? inFlight?.catch(() => undefined); // reported by the swallowAs above
  }

  async function classifyUserCached(client: any, userId: string | undefined): Promise<CachedUser & { ok: boolean }> {
    const cached = userId === undefined ? undefined : userCache.get(userId);
    if (cached) return { ...cached, ok: true };
    const fromSnapshot = (await getUserSnapshot(client))?.byId.get(userId ?? "");
    if (fromSnapshot) return { ...fromSnapshot, ok: true };
    try {
      const user = (await client.users.info({ user: userId })).user as SlackUser | undefined;
      const timezone = slackUserTimezone(user);
      const classified = { actor: deps.classify(user), ...(timezone ? { timezone } : {}) };
      if (ids.ownTeamId && userId !== undefined) userCache.set(userId, classified);
      return { ...classified, ok: true };
    } catch (err) {
      swallow("slack: users.info classify", err);
      return { actor: { externalId: userId ?? "", isExternalGuest: true }, ok: false };
    }
  }

  return { current: () => snapshot, expire: () => void (snapshot = undefined), getUserSnapshot, classifyUserCached };
}

export type UserDirectory = ReturnType<typeof createUserDirectory>;

export type Directory = ReturnType<typeof createDirectory>;

export function createDirectory(deps: {
  externalAccess?: ExternalSlackAccess;
  core: SlackCoreClient;
  ids: BotIdentity;
  syncRetryMs?: number;
  coreSingleton?: boolean;
}) {
  const { core, ids } = deps;
  const CORE_SINGLETON = deps.coreSingleton !== false;
  const classify = (u: SlackUser | undefined): ActorAssertion =>
    deps.externalAccess ? companySlackActor(u, deps.externalAccess) : classifyUser(u, ids.ownTeamId, ids.identityMode);
  const ctx: DirectorySyncContext = {
    core,
    ids,
    coreSingleton: CORE_SINGLETON,
    classifyUserCached: (client, userId) => users.classifyUserCached(client, userId),
    seenGroupIds: new Set<string>(),
    expireUserSnapshot: () => users.expire(),
  };
  const users = createUserDirectory({
    ids,
    coreSingleton: CORE_SINGLETON,
    classify,
    onRefreshed: (snapshot, client) => pushDirectory(ctx, snapshot, client),
  });
  const sync = createDirectorySync(ctx, users, deps.syncRetryMs ?? 30_000);

  async function getChannelInfo(client: any, channel: string): Promise<ChannelMeta | undefined> {
    try {
      return (await client.conversations.info({ channel })).channel as ChannelMeta;
    } catch (err) {
      swallow("slack: conversations.info", err);
      return undefined;
    }
  }

  async function channelMembership(
    client: any,
    channel: string,
    actor: ActorAssertion,
    actorSlackId: string | undefined,
    info: ChannelMeta | undefined,
    observedAt?: number,
  ): Promise<ChannelMembership> {
    let membership: ChannelMembership;
    try {
      const memberIds = await fetchChannelMemberIds(client, ids.botUserId, channel);
      membership = await resolveChannelMembership({
        memberIds,
        actor,
        actorSlackId,
        info,
        classify: (id) => users.classifyUserCached(client, id),
      });
    } catch (err) {
      swallow("slack: channel membership", err);
      return { audience: [actor, externalMarker()] };
    }
    if (CORE_SINGLETON && !deps.externalAccess && !actor.isBot && !info?.is_mpim) {
      if (!info?.name || typeof info.is_private !== "boolean" || info.is_member === false || observedAt === undefined)
        return { audience: [actor, externalMarker()] };
      if (membership.publishMembers) {
        const applied = await core.pushDirectory({
          channels: [{ channelId: channel, name: info.name, isPrivate: info.is_private }],
          channelMembers: membership.publishMembers.map((member) => ({
            channelId: channel,
            principalId: member.externalId,
          })),
          channelRosterIds: [channel],
          channelsSyncedAt: observedAt,
          partialChannels: true,
        });
        if (!applied) throw new Error("Slack channel membership was not persisted before admission");
      }
    }
    return membership;
  }

  return {
    getUserSnapshot: users.getUserSnapshot,
    forceDirectorySync: sync.forceDirectorySync,
    classifyUserCached: users.classifyUserCached,
    classifyActor: async (client: any, userId: string) => (await users.classifyUserCached(client, userId)).actor,
    getChannelInfo,
    channelMembership,
    allInternalRosters: (client: any, refs: ReadonlyArray<RosterRef>, kind: RosterKind) =>
      allInternalRosters(ctx, client, refs, kind),
    syncForUnseenGroup: sync.syncForUnseenGroup,
    resolveAutoIdentityMode: (client: any) => resolveAutoIdentityMode(client, ids.ownTeamId),
  };
}

async function resolveAutoIdentityMode(client: any, ownTeamId: string): Promise<SlackIdentityMode> {
  for (let attempt = 1; ; attempt++) {
    try {
      let sawOwnTeamHuman = false;
      for await (const res of client.paginate("users.list", { limit: 1000 }) as AsyncIterable<{
        members?: SlackUser[];
      }>) {
        const evidence = probeIdentityMode(res.members ?? [], ownTeamId);
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
