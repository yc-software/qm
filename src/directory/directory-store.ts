import { ambientTenant, type Tenant } from "../tenants/context.ts";
import type { PrincipalType } from "../types.ts";

export interface DirectoryMember {
  principalId: string;
  displayName: string;
  type: PrincipalType;
  slackId?: string;
  avatarUrl?: string;
  isBot?: boolean;
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

interface SignInTenant {
  id: string;
  brandName?: string;
  handle?: string;
}

export interface DirectoryMeta {
  workspaceUrl: string | null;
}

export type RecipientResolution =
  { kind: "one"; member: DirectoryMember } | { kind: "ambiguous"; candidates: DirectoryMember[] } | { kind: "none" };

export type ChannelResolution =
  { kind: "one"; channel: DirectoryChannel } | { kind: "ambiguous"; candidates: DirectoryChannel[] } | { kind: "none" };

export interface DirectoryStore {
  replace(tenant: Tenant, members: DirectoryMember[], syncedAt?: number): Promise<boolean>;
  replaceChannels(
    tenant: Tenant,
    channels: DirectoryChannel[],
    channelMembers?: ChannelMembership[],
    syncedAt?: number,
    channelRosterIds?: string[],
    revocations?: ChannelMembership[],
    partial?: boolean,
  ): Promise<boolean>;
  list(tenant: Tenant): Promise<DirectoryMember[]>;
  listChannels(tenant: Tenant): Promise<DirectoryChannel[]>;
  get(tenant: Tenant, principalId: string): Promise<DirectoryMember | null>;
  getBySlackId(tenant: Tenant, slackId: string): Promise<DirectoryMember | null>;
  resolve(tenant: Tenant, query: string): Promise<RecipientResolution>;
  resolveChannel(tenant: Tenant, query: string): Promise<ChannelResolution>;
  channelMember(tenant: Tenant, channelId: string, principalId: string): Promise<boolean>;
  channelMembership(tenant: Tenant, channelId: string, principalId: string): Promise<boolean | undefined>;
  channelMemberIds(tenant: Tenant, channelId: string): Promise<string[] | undefined>;
  channelPrivacy(tenant: Tenant, channelId: string): Promise<boolean | undefined>;
  rosterCoversAudience(tenant: Tenant, channelId: string): Promise<boolean | undefined>;
  replaceGroups(
    tenant: Tenant,
    groupMembers: GroupMembership[],
    syncedAt?: number,
    groupIds?: string[],
    groupRosterIds?: string[],
  ): Promise<boolean>;
  upsertGroup(tenant: Tenant, groupId: string, principalIds: readonly string[]): Promise<void>;
  resolveGroupByParticipants(tenant: Tenant, participants: readonly string[]): Promise<GroupResolution>;
  groupMember(tenant: Tenant, groupId: string, principalId: string): Promise<boolean>;
  groupMembership(tenant: Tenant, groupId: string, principalId: string): Promise<boolean | undefined>;
  listGroupsFor(tenant: Tenant, principalId: string): Promise<string[]>;
  conversationMembers(tenant: Tenant, kind: "channel" | "group", id: string): Promise<DirectoryMember[] | undefined>;
  groupRosters(tenant: Tenant, groupIds: readonly string[]): Promise<Map<string, DirectoryMember[]>>;
  listChannelsFor(tenant: Tenant, principalId: string): Promise<DirectoryChannel[]>;
  setWorkspaceUrl(tenant: Tenant, url: string): Promise<void>;
  meta(tenant: Tenant): Promise<DirectoryMeta>;
  setAppHandle?(tenant: Tenant, handle: string): Promise<"ok" | "taken">;
  tenantsForEmail?(email: string): Promise<SignInTenant[]>;
  tenantsForPrincipal?(principal: string): Promise<SignInTenant[]>;
  tenantForAppHandle?(handle: string): Promise<string | undefined>;
  trustedClientFor?(tenant: string): Promise<{ clientId: string; clientSecret: string } | undefined>;
}

type TenantScoped = Exclude<
  keyof DirectoryStore,
  "setAppHandle" | "tenantsForEmail" | "tenantsForPrincipal" | "tenantForAppHandle" | "trustedClientFor"
>;

export type TenantDirectory = {
  [K in TenantScoped]: DirectoryStore[K] extends (tenant: Tenant, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

export function directoryFor(store: DirectoryStore, token: Tenant): TenantDirectory {
  return view(store, () => token);
}

export function directoryInBinding(store: DirectoryStore): TenantDirectory {
  return view(store, () => ambientTenant());
}

function view(store: DirectoryStore, tenant: () => Tenant): TenantDirectory {
  return {
    replace: async (...a) => store.replace(tenant(), ...a),
    replaceChannels: async (...a) => store.replaceChannels(tenant(), ...a),
    list: async () => store.list(tenant()),
    listChannels: async () => store.listChannels(tenant()),
    get: async (...a) => store.get(tenant(), ...a),
    getBySlackId: async (...a) => store.getBySlackId(tenant(), ...a),
    resolve: async (...a) => store.resolve(tenant(), ...a),
    resolveChannel: async (...a) => store.resolveChannel(tenant(), ...a),
    channelMember: async (...a) => store.channelMember(tenant(), ...a),
    channelMembership: async (...a) => store.channelMembership(tenant(), ...a),
    channelMemberIds: async (...a) => store.channelMemberIds(tenant(), ...a),
    channelPrivacy: async (...a) => store.channelPrivacy(tenant(), ...a),
    rosterCoversAudience: async (...a) => store.rosterCoversAudience(tenant(), ...a),
    replaceGroups: async (...a) => store.replaceGroups(tenant(), ...a),
    upsertGroup: async (...a) => store.upsertGroup(tenant(), ...a),
    resolveGroupByParticipants: async (...a) => store.resolveGroupByParticipants(tenant(), ...a),
    groupMember: async (...a) => store.groupMember(tenant(), ...a),
    groupMembership: async (...a) => store.groupMembership(tenant(), ...a),
    listGroupsFor: async (...a) => store.listGroupsFor(tenant(), ...a),
    conversationMembers: async (...a) => store.conversationMembers(tenant(), ...a),
    groupRosters: async (...a) => store.groupRosters(tenant(), ...a),
    listChannelsFor: async (...a) => store.listChannelsFor(tenant(), ...a),
    setWorkspaceUrl: async (...a) => store.setWorkspaceUrl(tenant(), ...a),
    meta: async () => store.meta(tenant()),
  };
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
