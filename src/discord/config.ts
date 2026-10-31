export const DISCORD_SURFACE = "discord";
export const DISCORD_DM_DELIVERY_TYPE = "discord-dm";
export const DISCORD_RETRY_BASE_MS = 5_000;
export const DISCORD_RETRY_MAX_MS = 300_000;
const EXTERNAL_PREFIX = `${DISCORD_SURFACE}:`;
export const discordDmThreadRef = (channelId: string): string => `${DISCORD_SURFACE}:dm:${channelId}`;
export const discordThreadRef = (threadId: string): string => `${DISCORD_SURFACE}:th:${threadId}`;
const DISCORD_THREAD_REF = new RegExp(`^${DISCORD_SURFACE}:th:(\\d+)$`);

export function discordRevisionThreadRefs(container: string, ts: string): string[] {
  return [...new Set([discordThreadRef(container), discordThreadRef(ts)])];
}

export function parseDiscordThreadRef(threadRef: string): { container: string } | null {
  const m = DISCORD_THREAD_REF.exec(threadRef);
  return m ? { container: m[1]! } : null;
}

export interface DiscordPluginConfig {
  botToken: string;
  guildIds: ReadonlySet<string>;
  internalRoleIds: ReadonlySet<string>;
}

export function discordExternalId(userId: string): string {
  return `${EXTERNAL_PREFIX}${userId}`;
}

export function discordUserIdOf(externalId: string): string | null {
  return externalId.startsWith(EXTERNAL_PREFIX) ? externalId.slice(EXTERNAL_PREFIX.length) : null;
}

export function recipientDiscordId(
  target: string,
  linkedIds: (principalId: string) => readonly string[],
): string | null {
  const own = discordUserIdOf(target);
  const linked = linkedIds(target);
  return own !== null && linked.includes(own) ? own : (linked[0] ?? null);
}
