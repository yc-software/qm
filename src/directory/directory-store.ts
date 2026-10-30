import { z } from "zod";
import type { PrincipalType } from "../types.ts";
import { rosterIds, samePerson } from "./person.ts";

function hasPerson(members: ReadonlySet<string> | undefined, principalId: string): boolean {
  return !!members && rosterIds(principalId).some((id) => members.has(id));
}

export interface DirectoryMember {
  principalId: string;
  displayName: string;
  type: PrincipalType;
  slackId?: string;
  avatarUrl?: string;
}

export interface DirectoryChannel {
  channelId: string;
  name: string;
  isPrivate?: boolean;
  isExternal?: boolean;
}

export interface ChannelMembership {
  channelId: string;
  principalId: string;
}

export interface GroupMembership {
  groupId: string;
  principalId: string;
}

export type GroupResolution = { kind: "one"; groupId: string } | { kind: "none" };

export function groupParticipantsKey(participants: readonly string[]): string {
  return [...new Set(participants.filter((p) => p))].sort().join(",");
}

export interface DirectoryMeta {
  workspaceUrl: string | null;
}

export type RecipientResolution =
  { kind: "one"; member: DirectoryMember } | { kind: "ambiguous"; candidates: DirectoryMember[] } | { kind: "none" };

export type ChannelResolution =
  { kind: "one"; channel: DirectoryChannel } | { kind: "ambiguous"; candidates: DirectoryChannel[] } | { kind: "none" };

const observedRoster = {
  id: z.string().min(1),
  memberIds: z.array(z.string().min(1)).min(1),
  observedAt: z.number().int().nonnegative(),
};

export const directoryObservation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), ...observedRoster, name: z.string().min(1), isPrivate: z.boolean() }).strict(),
  z.object({ kind: z.literal("group"), ...observedRoster }).strict(),
]);

export type DirectoryObservation = z.infer<typeof directoryObservation>;

export function staleObservation(
  observation: DirectoryObservation,
  crawledAt: number | undefined,
  storedAt: number | undefined,
): string | undefined {
  let reason: string | undefined;
  if (storedAt !== undefined && storedAt >= observation.observedAt) reason = "an equal or newer observation is stored";
  else if (crawledAt !== undefined && crawledAt >= observation.observedAt) reason = "an equal or newer crawl is stored";
  if (reason) console.warn(`[directory] rejected ${observation.kind} observation for ${observation.id}: ${reason}`);
  return reason;
}

export interface DirectoryStore {
  replace(members: DirectoryMember[], syncedAt?: number): Promise<boolean>;
  replaceChannels(
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
    channelRosterIds?: string[],
    revocations?: ChannelMembership[],
  ): Promise<boolean>;
  recordObservation(observation: DirectoryObservation): Promise<boolean>;
  list(): Promise<DirectoryMember[]>;
  listChannels(): Promise<DirectoryChannel[]>;
  get(principalId: string): Promise<DirectoryMember | null>;
  getBySlackId(slackId: string): Promise<DirectoryMember | null>;
  resolve(query: string): Promise<RecipientResolution>;
  resolveChannel(query: string): Promise<ChannelResolution>;
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  channelMembership(channelId: string, principalId: string): Promise<boolean | undefined>;
  channelMemberIds(channelId: string): Promise<string[] | undefined>;
  channelPrivacy(channelId: string): Promise<boolean | undefined>;
  replaceGroups(
    groupMembers: GroupMembership[],
    syncedAt?: number,
    groupIds?: string[],
    groupRosterIds?: string[],
  ): Promise<boolean>;
  upsertGroup(groupId: string, principalIds: readonly string[]): Promise<void>;
  resolveGroupByParticipants(participants: readonly string[]): Promise<GroupResolution>;
  groupMember(groupId: string, principalId: string): Promise<boolean>;
  groupMembership(groupId: string, principalId: string): Promise<boolean | undefined>;
  listGroupsFor(principalId: string): Promise<string[]>;
  conversationMembers(kind: "channel" | "group", id: string): Promise<DirectoryMember[] | undefined>;
  listChannelsFor(principalId: string): Promise<DirectoryChannel[]>;
  setWorkspaceUrl(url: string): Promise<void>;
  meta(): Promise<DirectoryMeta>;
}

export const MAX_CANDIDATES = 10;
export const normDirectoryQuery = (s: string): string => s.trim().toLowerCase().replace(/^[@#]/, "");

export function pickMatch<T>(
  items: T[],
  query: string,
  id: (t: T) => string,
  label: (t: T) => string,
): { kind: "one"; item: T } | { kind: "ambiguous"; items: T[] } | { kind: "none" } {
  const q = normDirectoryQuery(query);
  if (!q) return { kind: "none" };
  const byId = items.find((t) => id(t).toLowerCase() === q);
  if (byId) return { kind: "one", item: byId };
  const exact = items.filter((t) => normDirectoryQuery(label(t)) === q);
  if (exact.length === 1) return { kind: "one", item: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", items: exact.slice(0, MAX_CANDIDATES) };
  const prefix = items.filter((t) => normDirectoryQuery(label(t)).startsWith(q));
  const pool = prefix.length ? prefix : items.filter((t) => normDirectoryQuery(label(t)).includes(q));
  if (pool.length === 0) return { kind: "none" };
  if (pool.length === 1) return { kind: "one", item: pool[0]! };
  return { kind: "ambiguous", items: pool.slice(0, MAX_CANDIDATES) };
}

export function createDirectoryStore(): DirectoryStore {
  let members: DirectoryMember[] = [];
  let channels: DirectoryChannel[] = [];
  let channelMembers: Map<string, Set<string>> | undefined;
  let knownChannelRosters: Set<string> | undefined;
  let groupMembers: Map<string, Set<string>> | undefined;
  let listedGroupIds: Set<string> | undefined;
  let knownGroupRosters: Set<string> | undefined;
  let groupsSynced = false;
  let workspaceUrl: string | undefined;
  const syncedAts = new Map<string, number>();
  const channelObservedAts = new Map<string, number>();
  const groupObservedAts = new Map<string, number>();

  function acceptSync(section: string, syncedAt: number | undefined): boolean {
    if (syncedAt === undefined) return true;
    const stored = syncedAts.get(section);
    if (stored !== undefined && stored > syncedAt) {
      console.warn(`[directory] refused stale ${section} swap: stamped ${stored - syncedAt}ms behind`);
      return false;
    }
    syncedAts.set(section, syncedAt);
    return true;
  }

  function newerObservations(observedAts: Map<string, number>, syncedAt: number | undefined) {
    return new Set([...observedAts].filter(([, at]) => syncedAt !== undefined && at > syncedAt).map(([id]) => id));
  }

  return {
    async setWorkspaceUrl(url) {
      workspaceUrl = url;
    },
    async meta() {
      return { workspaceUrl: workspaceUrl ?? null };
    },
    async replace(next, syncedAt) {
      if (!acceptSync("members", syncedAt)) return false;
      members = next.filter((m) => m.principalId && m.type === "internal");
      return true;
    },
    async replaceChannels(nextChannels, nextChannelMembers, syncedAt, nextChannelRosterIds, revocations = []) {
      const protectedIds = newerObservations(channelObservedAts, syncedAt);
      if (!acceptSync("channels", syncedAt)) return false;
      const updatedIds = new Set(nextChannels.map((channel) => channel.channelId));
      channels = [
        ...channels.filter((channel) => protectedIds.has(channel.channelId)),
        ...nextChannels.filter((c) => c.channelId && c.name && !protectedIds.has(c.channelId)),
      ];
      for (const id of updatedIds) if (!protectedIds.has(id)) channelObservedAts.delete(id);
      const listed = new Set(channels.map((channel) => channel.channelId));
      knownChannelRosters = knownChannelRosters
        ? new Set([...knownChannelRosters].filter((channelId) => listed.has(channelId)))
        : undefined;
      if (nextChannelMembers !== undefined) {
        const rosterIds = new Set(
          (nextChannelRosterIds ?? nextChannels.map((channel) => channel.channelId)).filter(
            (id) => updatedIds.has(id) && !protectedIds.has(id),
          ),
        );
        const byChannel = new Map(
          [...(channelMembers ?? [])].filter(([channelId]) => listed.has(channelId) && !rosterIds.has(channelId)),
        );
        for (const channelId of rosterIds) if (listed.has(channelId)) byChannel.set(channelId, new Set());
        for (const m of nextChannelMembers) {
          if (!m.channelId || !m.principalId || !rosterIds.has(m.channelId) || !listed.has(m.channelId)) continue;
          (byChannel.get(m.channelId) ?? byChannel.set(m.channelId, new Set()).get(m.channelId)!).add(m.principalId);
        }
        channelMembers = byChannel;
        knownChannelRosters ??= new Set();
        for (const channelId of rosterIds) if (listed.has(channelId)) knownChannelRosters.add(channelId);
      }
      for (const member of revocations) {
        if (updatedIds.has(member.channelId) && !protectedIds.has(member.channelId) && member.principalId)
          channelMembers?.get(member.channelId)?.delete(member.principalId);
      }
      for (const id of channelObservedAts.keys()) if (!listed.has(id)) channelObservedAts.delete(id);
      return true;
    },
    async channelMember(channelId, principalId) {
      if (channels.some((channel) => channel.channelId === channelId && channel.isPrivate && channel.isExternal))
        return false;
      return hasPerson(channelMembers?.get(channelId), principalId);
    },
    async channelMemberIds(channelId) {
      if (!knownChannelRosters?.has(channelId)) return undefined;
      return [...(channelMembers?.get(channelId) ?? [])];
    },
    async channelMembership(channelId, principalId) {
      const channel = channels.find((candidate) => candidate.channelId === channelId);
      if (!channel || !knownChannelRosters?.has(channelId)) return undefined;
      const member = hasPerson(channelMembers?.get(channelId), principalId);
      return member || channel.isPrivate === true ? member : undefined;
    },
    async channelPrivacy(channelId) {
      const channel = channels.find((candidate) => candidate.channelId === channelId);
      return channel ? channel.isPrivate === true : undefined;
    },
    async replaceGroups(nextGroupMembers, syncedAt, nextGroupIds, nextGroupRosterIds) {
      const protectedIds = newerObservations(groupObservedAts, syncedAt);
      if (!acceptSync("groups", syncedAt)) return false;
      const updated = new Set((nextGroupIds ?? nextGroupMembers.map((member) => member.groupId)).filter(Boolean));
      for (const groupId of protectedIds) updated.delete(groupId);
      const legacy = nextGroupIds === undefined || nextGroupRosterIds === undefined;
      const listed = new Set([...updated, ...protectedIds]);
      const rosterIds = new Set((nextGroupRosterIds ?? [...updated]).filter((groupId) => updated.has(groupId)));
      const byGroup = new Map(
        [...(groupMembers ?? [])].filter(([groupId]) => listed.has(groupId) && !rosterIds.has(groupId)),
      );
      for (const groupId of rosterIds) byGroup.set(groupId, new Set());
      for (const m of nextGroupMembers) {
        if (!m.groupId || !m.principalId || !rosterIds.has(m.groupId)) continue;
        (byGroup.get(m.groupId) ?? byGroup.set(m.groupId, new Set()).get(m.groupId)!).add(m.principalId);
      }
      groupMembers = byGroup;
      listedGroupIds = listed;
      knownGroupRosters = new Set(
        [...(knownGroupRosters ?? [])].filter(
          (groupId) => listed.has(groupId) && (!legacy || protectedIds.has(groupId)),
        ),
      );
      for (const groupId of rosterIds) knownGroupRosters.add(groupId);
      for (const groupId of updated) groupObservedAts.delete(groupId);
      for (const groupId of groupObservedAts.keys()) if (!listed.has(groupId)) groupObservedAts.delete(groupId);
      groupsSynced = true;
      return true;
    },
    async recordObservation(observation) {
      const observedAts = observation.kind === "channel" ? channelObservedAts : groupObservedAts;
      if (staleObservation(observation, syncedAts.get(`${observation.kind}s`), observedAts.get(observation.id)))
        return false;
      const roster = new Set(observation.memberIds);
      if (observation.kind === "channel") {
        const { id: channelId, name, isPrivate } = observation;
        channels = [...channels.filter((c) => c.channelId !== channelId), { channelId, name, isPrivate }];
        (channelMembers ??= new Map()).set(channelId, roster);
        (knownChannelRosters ??= new Set()).add(channelId);
      } else {
        (groupMembers ??= new Map()).set(observation.id, roster);
        (listedGroupIds ??= new Set()).add(observation.id);
        (knownGroupRosters ??= new Set()).add(observation.id);
      }
      observedAts.set(observation.id, observation.observedAt);
      return true;
    },
    async upsertGroup(groupId, principalIds) {
      const ids = principalIds.filter(Boolean);
      if (!groupId || !ids.length) return;
      const byGroup = groupMembers ?? new Map<string, Set<string>>();
      byGroup.set(groupId, new Set(ids));
      groupMembers = byGroup;
      listedGroupIds ??= new Set();
      listedGroupIds.add(groupId);
      knownGroupRosters ??= new Set();
      knownGroupRosters.add(groupId);
      const stored = syncedAts.get("groups");
      syncedAts.set("groups", Math.max(stored ?? 0, Date.now()));
    },
    async resolveGroupByParticipants(participants) {
      const key = groupParticipantsKey(participants);
      if (!key) return { kind: "none" };
      const groups = groupMembers;
      if (groups) {
        for (const [groupId, members] of groups) {
          if (groupParticipantsKey([...members]) === key) return { kind: "one", groupId };
        }
      }
      return { kind: "none" };
    },
    async groupMember(groupId, principalId) {
      return hasPerson(groupMembers?.get(groupId), principalId);
    },
    async groupMembership(groupId, principalId) {
      if (listedGroupIds?.has(groupId) && knownGroupRosters?.has(groupId))
        return hasPerson(groupMembers?.get(groupId), principalId);
      if (!groupsSynced) return undefined;
      return listedGroupIds?.has(groupId) ? undefined : false;
    },
    async listGroupsFor(principalId) {
      const memberships = groupMembers;
      if (!memberships) return [];
      return [...memberships].filter(([, members]) => hasPerson(members, principalId)).map(([groupId]) => groupId);
    },
    async conversationMembers(kind, id) {
      let ids: string[];
      if (kind === "channel") {
        const channel = channels.find((candidate) => candidate.channelId === id);
        if (!channel || channel.isExternal || !knownChannelRosters?.has(id)) return undefined;
        ids = [...(channelMembers?.get(id) ?? [])];
      } else {
        if (!knownGroupRosters?.has(id)) return undefined;
        ids = [...(groupMembers?.get(id) ?? [])];
      }
      if (!ids.length) return undefined;
      const roster = ids
        .map((principalId) => members.find((member) => samePerson(member.principalId, principalId)))
        .filter((member): member is DirectoryMember => member !== undefined);
      return roster.length === ids.length ? roster : undefined;
    },
    async listChannelsFor(principalId) {
      return channels.filter(
        (channel) =>
          !channel.isPrivate || (!channel.isExternal && hasPerson(channelMembers?.get(channel.channelId), principalId)),
      );
    },
    async list() {
      return members;
    },
    async listChannels() {
      return channels;
    },
    async get(principalId) {
      return members.find((m) => samePerson(m.principalId, principalId)) ?? null;
    },
    async getBySlackId(slackId) {
      return members.find((m) => (m.slackId ?? m.principalId) === slackId) ?? null;
    },
    async resolve(query) {
      const bySlackId = members.find((x) => x.slackId && x.slackId === query.trim());
      if (bySlackId) return { kind: "one", member: bySlackId };
      const m = pickMatch(
        members,
        query,
        (x) => x.principalId,
        (x) => x.displayName,
      );
      if (m.kind === "one") return { kind: "one", member: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },
    async resolveChannel(query) {
      const m = pickMatch(
        channels,
        query,
        (x) => x.channelId,
        (x) => x.name,
      );
      if (m.kind === "one") return { kind: "one", channel: m.item };
      if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.items };
      return { kind: "none" };
    },
  };
}
