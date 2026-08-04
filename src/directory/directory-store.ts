import type { PrincipalType } from "../types.ts";
import { samePerson } from "./person.ts";

export interface DirectoryMember {
  principalId: string;
  displayName: string;
  type: PrincipalType;
  slackId?: string;
}

export interface DirectoryChannel {
  channelId: string;
  name: string;
  isPrivate?: boolean;
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

export interface DirectoryStore {
  replace(members: DirectoryMember[], syncedAt?: number): Promise<boolean>;
  replaceChannels(
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
  ): Promise<boolean>;
  list(): Promise<DirectoryMember[]>;
  listChannels(): Promise<DirectoryChannel[]>;
  get(principalId: string): Promise<DirectoryMember | null>;
  resolve(query: string): Promise<RecipientResolution>;
  resolveChannel(query: string): Promise<ChannelResolution>;
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  channelMembership(channelId: string, principalId: string): Promise<boolean | undefined>;
  channelPrivacy(channelId: string): Promise<boolean | undefined>;
  replaceGroups(groupMembers: GroupMembership[], syncedAt?: number): Promise<boolean>;
  upsertGroup(groupId: string, principalIds: readonly string[]): Promise<void>;
  resolveGroupByParticipants(participants: readonly string[]): Promise<GroupResolution>;
  groupMember(groupId: string, principalId: string): Promise<boolean>;
  groupMembership(groupId: string, principalId: string): Promise<boolean | undefined>;
  listGroupsFor(principalId: string): Promise<string[]>;
  listChannelsFor(principalId: string): Promise<DirectoryChannel[]>;
  setWorkspaceUrl(url: string): Promise<void>;
  meta(): Promise<DirectoryMeta>;
}

export const MAX_CANDIDATES = 10;
export const normDirectoryQuery = (s: string): string => s.trim().toLowerCase().replace(/^[@#]/, "");

function pickMatch<T>(
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
  let groupMembers: Map<string, Set<string>> | undefined;
  let groupsSynced = false;
  let workspaceUrl: string | undefined;
  const syncedAts = new Map<string, number>();

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
    async replaceChannels(nextChannels, nextChannelMembers, syncedAt) {
      if (!acceptSync("channels", syncedAt)) return false;
      channels = nextChannels.filter((c) => c.channelId && c.name);
      if (nextChannelMembers !== undefined) {
        const byChannel = new Map<string, Set<string>>();
        for (const m of nextChannelMembers) {
          if (!m.channelId || !m.principalId) continue;
          (byChannel.get(m.channelId) ?? byChannel.set(m.channelId, new Set()).get(m.channelId)!).add(m.principalId);
        }
        channelMembers = byChannel;
      }
      return true;
    },
    async channelMember(channelId, principalId) {
      return channelMembers?.get(channelId)?.has(principalId) ?? false;
    },
    async channelMembership(channelId, principalId) {
      const memberships = channelMembers;
      const channel = channels.find((candidate) => candidate.channelId === channelId);
      if (!memberships || !channel) return undefined;
      const member = memberships.get(channelId)?.has(principalId) ?? false;
      return member || channel.isPrivate === true ? member : undefined;
    },
    async channelPrivacy(channelId) {
      const channel = channels.find((candidate) => candidate.channelId === channelId);
      return channel ? channel.isPrivate === true : undefined;
    },
    async replaceGroups(nextGroupMembers, syncedAt) {
      if (!acceptSync("groups", syncedAt)) return false;
      const byGroup = new Map<string, Set<string>>();
      for (const m of nextGroupMembers) {
        if (!m.groupId || !m.principalId) continue;
        (byGroup.get(m.groupId) ?? byGroup.set(m.groupId, new Set()).get(m.groupId)!).add(m.principalId);
      }
      groupMembers = byGroup;
      groupsSynced = true;
      return true;
    },
    async upsertGroup(groupId, principalIds) {
      const ids = principalIds.filter(Boolean);
      if (!groupId || !ids.length) return;
      const byGroup = groupMembers ?? new Map<string, Set<string>>();
      byGroup.set(groupId, new Set(ids));
      groupMembers = byGroup;
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
      return groupMembers?.get(groupId)?.has(principalId) ?? false;
    },
    async groupMembership(groupId, principalId) {
      const memberships = groupMembers;
      if (!memberships || !groupsSynced) return undefined;
      return memberships.get(groupId)?.has(principalId) ?? false;
    },
    async listGroupsFor(principalId) {
      const memberships = groupMembers;
      if (!memberships) return [];
      return [...memberships].filter(([, members]) => members.has(principalId)).map(([groupId]) => groupId);
    },
    async listChannelsFor(principalId) {
      return channels.filter((c) => !c.isPrivate || (channelMembers?.get(c.channelId)?.has(principalId) ?? false));
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
