import type { PrincipalType } from "../types.ts";

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

export interface DirectoryStore {
  replace(members: DirectoryMember[], syncedAt?: number): Promise<boolean>;
  replaceChannels(
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
    channelRosterIds?: string[],
    revocations?: ChannelMembership[],
    partial?: boolean,
  ): Promise<boolean>;
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
