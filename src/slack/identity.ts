import { LRUCache } from "lru-cache";

export interface ActorAssertion {
  externalId: string;
  isExternalGuest?: boolean;
  isBot?: boolean;
  displayName?: string;
}

export interface SlackUser {
  id?: string;
  team_id?: string;
  tz?: string;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  is_bot?: boolean;
  real_name?: string;
  name?: string;
  profile?: { display_name?: string; email?: string; tz?: string };
}

export type SlackIdentityMode = "slack-id" | "email";

export interface UserCache {
  get(userId: string): CachedUser | undefined;
  set(userId: string, user: CachedUser): void;
}

export interface CachedUser {
  actor: ActorAssertion;
  timezone?: string;
}

export function createUserCache(opts: { ttlMs?: number; max?: number } = {}): UserCache {
  return new LRUCache<string, CachedUser>({ max: opts.max ?? 5000, ttl: opts.ttlMs ?? 5 * 60_000 });
}

export function classifyUser(
  u: SlackUser | undefined,
  ownTeamId: string,
  identity: SlackIdentityMode = "slack-id",
): ActorAssertion {
  const user = u ?? {};
  let isGuest = Boolean(
    !u ||
    user.deleted ||
    user.is_restricted ||
    user.is_ultra_restricted ||
    user.is_stranger ||
    (user.team_id && ownTeamId && user.team_id !== ownTeamId),
  );
  const displayName = user.profile?.display_name || user.real_name || user.name || user.id || "";
  let externalId = String(user.id ?? "");
  if (identity === "email" && !user.is_bot) {
    const email = (user.profile?.email ?? "").trim().toLowerCase();
    if (email.includes("@")) externalId = email;
    else isGuest = true;
  }
  return {
    externalId,
    isExternalGuest: isGuest,
    ...(user.is_bot ? { isBot: true } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export function slackUserTimezone(u: SlackUser | undefined): string | undefined {
  let raw = "";
  if (typeof u?.tz === "string") raw = u.tz;
  else if (typeof u?.profile?.tz === "string") raw = u.profile.tz;
  const timezone = raw.trim();
  if (!timezone || timezone.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return undefined;
  }
}

export function externalMarker(): ActorAssertion {
  return { externalId: "slack-external", isExternalGuest: true };
}

export function probeIdentityMode(members: SlackUser[], ownTeamId: string): SlackIdentityMode | "undecided" {
  const own = members.filter((u) => u?.id && !u.is_bot && !u.deleted && u.team_id === ownTeamId);
  if (own.length === 0) return "undecided";
  return own.some((u) => (u.profile?.email ?? "").includes("@")) ? "email" : "slack-id";
}

export interface ChannelMeta {
  name?: string;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  purpose?: { value?: string };
  topic?: { value?: string; creator?: string };
}

export function isMpim(info: ChannelMeta | undefined): boolean {
  return Boolean(info?.is_mpim);
}

export function groupDmDisplayName(members: readonly ActorAssertion[]): string | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (member.isExternalGuest) continue;
    const name = (member.displayName ?? member.externalId).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length ? names.join(", ") : undefined;
}

export function isExternallyShared(info: ChannelMeta | undefined): boolean {
  return Boolean(info?.is_ext_shared || info?.is_pending_ext_shared);
}

export function computeChannelAudience(
  actor: ActorAssertion,
  members: ActorAssertion[] | null,
  info: ChannelMeta | undefined,
): ActorAssertion[] {
  if (members && members.length) {
    const byId = new Map<string, ActorAssertion>();
    for (const m of [actor, ...members]) if (m.externalId) byId.set(m.externalId, m);
    const audience = [...byId.values()];
    if (isExternallyShared(info) && audience.every((m) => !m.isExternalGuest)) {
      audience.push(externalMarker());
    }
    return audience;
  }
  if (isExternallyShared(info)) return [actor, externalMarker()];
  return [actor];
}

export function computePublishMembers(
  actor: ActorAssertion,
  members: ActorAssertion[],
  complete: boolean,
  info: ChannelMeta | undefined,
): ActorAssertion[] | undefined {
  if (!complete) return undefined;
  if (isExternallyShared(info)) return undefined;
  const all = [actor, ...members];
  if (all.some((m) => m.isExternalGuest)) return undefined;
  const byId = new Map<string, ActorAssertion>();
  for (const m of all) if (m.externalId) byId.set(m.externalId, m);
  return [...byId.values()];
}

export function allInternalChannelMembers(
  members: ActorAssertion[],
  complete: boolean,
  info: ChannelMeta | undefined,
): string[] | undefined {
  if (!complete) return undefined;
  if (isExternallyShared(info)) return undefined;
  if (members.some((m) => m.isExternalGuest)) return undefined;
  return internalChannelMembers(members, true);
}

export function internalChannelMembers(members: ActorAssertion[], complete: boolean): string[] | undefined {
  if (!complete) return undefined;
  const ids = new Set<string>();
  for (const m of members) if (m.externalId && !m.isExternalGuest) ids.add(m.externalId);
  return [...ids];
}

export async function resolveChannelMembership(opts: {
  memberIds: readonly string[];
  actor: ActorAssertion;
  actorSlackId: string;
  info: ChannelMeta | undefined;
  classify(id: string): Promise<{ actor: ActorAssertion; ok: boolean }>;
}): Promise<{
  audience: ActorAssertion[];
  publishMembers?: ActorAssertion[];
  slackIdsByPrincipal?: Map<string, string>;
}> {
  const { memberIds, actor, info } = opts;
  if (!actor.isBot && !memberIds.includes(opts.actorSlackId)) return { audience: [actor, externalMarker()] };

  const members: ActorAssertion[] = [];
  const slackIdsByPrincipal = new Map<string, string>();
  let complete = true;
  for (const id of memberIds) {
    const { actor: member, ok } = await opts.classify(id);
    members.push(member);
    if (member.externalId && !member.isExternalGuest) slackIdsByPrincipal.set(member.externalId, id);
    if (!ok) complete = false;
  }
  const audience = computeChannelAudience(actor, members, info);
  const publishMembers = computePublishMembers(actor, members, complete, info);
  return { audience, ...(publishMembers ? { publishMembers } : {}), slackIdsByPrincipal };
}
