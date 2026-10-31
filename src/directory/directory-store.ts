import type { PrincipalType } from "../types.ts";
import { discordUserIdOf } from "../discord/config.ts";
import { SNOWFLAKE } from "../util/snowflake.ts";

export const isDiscordMember = (m: { principalId: string }): boolean => discordUserIdOf(m.principalId) !== null;
export const isDiscordChannelId = (channelId: string): boolean => SNOWFLAKE.test(channelId);
export const isSlackChannelId = (channelId: string): boolean => /^[CG][A-Z0-9]{6,}$/.test(channelId);
export type ChannelSurface = "slack" | "discord";
export const isSurfaceChannel = (surface: ChannelSurface, channelId: string): boolean =>
  isDiscordChannelId(channelId) === (surface === "discord");

export interface DirectoryMember {
  principalId: string;
  displayName: string;
  type: PrincipalType;
  slackId?: string;
  avatarUrl?: string;
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{8,}$/;

export function slackIdOf(member: Pick<DirectoryMember, "principalId" | "slackId">): string | undefined {
  return member.slackId ?? (SLACK_ID_RE.test(member.principalId) ? member.principalId : undefined);
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
  replaceDiscord(members: DirectoryMember[]): Promise<void>;
  replaceChannels(
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
    channelRosterIds?: string[],
    revocations?: ChannelMembership[],
    partial?: boolean,
  ): Promise<boolean>;
  replaceDiscordChannels(
    channels: DirectoryChannel[],
    channelMembers: ChannelMembership[],
    syncedAt: number,
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

export type SlicePick<T> =
  { kind: "one"; item: T; exact?: true } | { kind: "ambiguous"; items: T[]; exact?: true } | { kind: "none" };

export function mergeSlicePicks<T>(picks: SlicePick<T>[]): SlicePick<T> {
  const found = picks.filter((p) => p.kind !== "none");
  if (found.length < 2) return found[0] ?? { kind: "none" };
  const [first, ...rest] = found;
  if (first!.kind === "one" && first!.exact && rest.every((p) => !p.exact)) return first!;
  const items = found.flatMap((p) => {
    if (p.kind === "one") return [p.item];
    return p.kind === "ambiguous" ? p.items : [];
  });
  return { kind: "ambiguous", items: items.slice(0, MAX_CANDIDATES) };
}

function pickByLabel<T>(items: T[], q: string, label: (t: T) => string): SlicePick<T> {
  const exact = items.filter((t) => normDirectoryQuery(label(t)) === q);
  if (exact.length === 1) return { kind: "one", item: exact[0]!, exact: true };
  if (exact.length > 1) return { kind: "ambiguous", items: exact.slice(0, MAX_CANDIDATES), exact: true };
  const prefix = items.filter((t) => normDirectoryQuery(label(t)).startsWith(q));
  const pool = prefix.length ? prefix : items.filter((t) => normDirectoryQuery(label(t)).includes(q));
  if (pool.length === 0) return { kind: "none" };
  if (pool.length === 1) return { kind: "one", item: pool[0]! };
  return { kind: "ambiguous", items: pool.slice(0, MAX_CANDIDATES) };
}

export function pickMatch<T>(
  items: T[],
  query: string,
  id: (t: T) => string,
  label: (t: T) => string,
  isDiscord?: (t: T) => boolean,
): SlicePick<T> {
  const q = normDirectoryQuery(query);
  if (!q) return { kind: "none" };
  const byId = items.find((t) => id(t).toLowerCase() === q);
  if (byId) return { kind: "one", item: byId };
  if (!isDiscord) return pickByLabel(items, q, label);
  return mergeSlicePicks([
    pickByLabel(
      items.filter((t) => !isDiscord(t)),
      q,
      label,
    ),
    pickByLabel(items.filter(isDiscord), q, label),
  ]);
}
