import { randomUUID } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { SNOWFLAKE } from "../util/snowflake.ts";
import type { DiscordPluginConfig } from "../discord/config.ts";
import type { ReloadableSurfaceConfig } from "./surface-runtime.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export const DISCORD_API = "https://discord.com/api/v10";
const MAX_IDS = 500;
const DISCORD_API_TIMEOUT_MS = 10_000;

export class DiscordInstallationError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export interface DiscordInstallationSettings {
  guildIds: string[];
  internalRoleIds: string[];
}

export interface StoredDiscordInstallation extends DiscordInstallationSettings {
  botTokenEnc: string;
  oauthClientSecretEnc: string | null;
  botUserId: string;
  botTag: string;
  applicationId: string;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

export interface DiscordInstallation extends DiscordInstallationSettings {
  botToken: string;
  botUserId: string;
  botTag: string;
  applicationId: string;
  oauthClientSecret: string | null;
  version: string;
}

interface DiscordInstallationStatus extends DiscordInstallationSettings {
  configured: boolean;
  botUserId?: string;
  botTag?: string;
  applicationId?: string;
  oauthConfigured: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export interface DiscordBotIdentity {
  userId: string;
  tag: string;
  applicationId: string;
}

const DISCORD_LINK_RETURN_PATH = "/settings";

export function discordLinkRedirectUri(portalUrl: string): string {
  return `${portalUrl.replace(/\/+$/, "")}${DISCORD_LINK_RETURN_PATH}`;
}

export interface DiscordInstallationStore {
  get(): Promise<DiscordInstallation | null>;
  status(): Promise<DiscordInstallationStatus>;
  set(
    input: DiscordInstallationSettings & {
      bot?: DiscordBotIdentity & { token: string };
      oauthClientSecret?: string;
      updatedBy: string;
    },
  ): Promise<DiscordInstallationStatus>;
  delete(): Promise<void>;
}

const EMPTY_SETTINGS: DiscordInstallationSettings = {
  guildIds: [],
  internalRoleIds: [],
};

function idsFrom(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IDS) {
    throw new DiscordInstallationError(400, `${field} must be a list of at most ${MAX_IDS} ids`);
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") {
      throw new DiscordInstallationError(400, `${field} has an invalid Discord id`);
    }
    const id = v.trim();
    if (!SNOWFLAKE.test(id)) {
      throw new DiscordInstallationError(400, `${field} has an invalid Discord id`);
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

function secretFrom(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function parseDiscordSettings(
  body: unknown,
): DiscordInstallationSettings & { botToken?: string; oauthClientSecret?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const botToken = secretFrom(b.botToken);
  const oauthClientSecret = secretFrom(b.oauthClientSecret);
  const guildIds = idsFrom(b.guildIds, "guildIds");
  const internalRoleIds = idsFrom(b.internalRoleIds, "internalRoleIds");
  const guildSet = new Set(guildIds);
  if (internalRoleIds.some((id) => guildSet.has(id))) {
    throw new DiscordInstallationError(400, "internalRoleIds cannot contain guild ids");
  }
  return {
    guildIds,
    internalRoleIds,
    ...(botToken ? { botToken } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
  };
}

async function botGet(path: string, token: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new DiscordInstallationError(502, "Discord did not answer. Try again in a minute.", { cause });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new DiscordInstallationError(502, "Discord did not answer. Try again in a minute.", {
      cause: new Error(`Discord ${path} responded ${res.status}`),
    });
  }
  if (!res.ok) {
    throw new DiscordInstallationError(400, "Discord rejected the bot token", {
      cause: new Error(`Discord ${path} responded ${res.status}`),
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (cause) {
    throw new DiscordInstallationError(502, "Discord returned an unexpected response", { cause });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DiscordInstallationError(502, "Discord returned an unexpected response");
  }
  return data as Record<string, unknown>;
}

export async function validateDiscordToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordBotIdentity> {
  const me = await botGet("/users/@me", token, fetchImpl);
  const app = await botGet("/oauth2/applications/@me", token, fetchImpl);
  if (typeof me.id !== "string" || typeof me.username !== "string" || typeof app.id !== "string") {
    throw new DiscordInstallationError(502, "Discord returned an unexpected bot identity");
  }
  const tag =
    typeof me.discriminator === "string" && me.discriminator !== "0"
      ? `${me.username}#${me.discriminator}`
      : me.username;
  return { userId: me.id, tag, applicationId: app.id };
}

export function createDiscordInstallationStore(
  orgId: string,
  map: DurableMap<StoredDiscordInstallation>,
  keyMaterial: Buffer | string,
): DiscordInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "discord-installation");
  const read = () => map.get(orgId);
  const getStatus = async (): Promise<DiscordInstallationStatus> => {
    const r = await read();
    if (!r) return { configured: false, oauthConfigured: false, ...EMPTY_SETTINGS };
    return {
      configured: true,
      botUserId: r.botUserId,
      botTag: r.botTag,
      applicationId: r.applicationId,
      oauthConfigured: r.oauthClientSecretEnc !== null,
      guildIds: r.guildIds,
      internalRoleIds: r.internalRoleIds,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    };
  };
  return {
    async get() {
      const r = await read();
      if (!r) return null;
      return {
        botToken: decryptSecret(r.botTokenEnc, key),
        oauthClientSecret: r.oauthClientSecretEnc ? decryptSecret(r.oauthClientSecretEnc, key) : null,
        botUserId: r.botUserId,
        botTag: r.botTag,
        applicationId: r.applicationId,
        guildIds: r.guildIds,
        internalRoleIds: r.internalRoleIds,
        version: r.version,
      };
    },
    status: getStatus,
    async set(input) {
      if (!map.update) throw new Error("Atomic installation updates are required");
      const previous = await read();
      if (!input.bot && !previous) throw new DiscordInstallationError(400, "a bot token is required");
      const updatedAt = Date.now();
      const toRecord = (active: StoredDiscordInstallation | null): StoredDiscordInstallation => {
        if (!input.bot && !active) throw new DiscordInstallationError(400, "a bot token is required");
        const botTokenEnc = input.bot ? encryptSecret(input.bot.token, key) : active!.botTokenEnc;
        let oauthClientSecretEnc: string | null = null;
        if (input.oauthClientSecret) {
          oauthClientSecretEnc = encryptSecret(input.oauthClientSecret, key);
        } else if (active) {
          if (!input.bot || input.bot.applicationId === active.applicationId) {
            oauthClientSecretEnc = active.oauthClientSecretEnc;
          }
        }
        const botUserId = input.bot ? input.bot.userId : active!.botUserId;
        const botTag = input.bot ? input.bot.tag : active!.botTag;
        const applicationId = input.bot ? input.bot.applicationId : active!.applicationId;
        return {
          botTokenEnc,
          oauthClientSecretEnc,
          botUserId,
          botTag,
          applicationId,
          guildIds: input.guildIds,
          internalRoleIds: input.internalRoleIds,
          version: `${updatedAt}:${randomUUID()}`,
          updatedAt,
          updatedBy: input.updatedBy,
        };
      };
      if (!previous) {
        await map.putIfAbsent(orgId, toRecord(null));
      }
      const stored = await map.update(orgId, toRecord);
      if (!stored) throw new Error("Discord installation disappeared during update");
      return getStatus();
    },
    async delete() {
      await map.delete(orgId);
    },
  };
}

export function discordPluginConfigFromInstallation(i: DiscordInstallation): DiscordPluginConfig {
  return {
    botToken: i.botToken,
    guildIds: new Set(i.guildIds),
    internalRoleIds: new Set(i.internalRoleIds),
  };
}

export async function loadDiscordRuntimeConfig(
  store: Pick<DiscordInstallationStore, "get">,
): Promise<ReloadableSurfaceConfig<DiscordPluginConfig> | null> {
  const stored = await store.get();
  return stored ? { version: stored.version, config: discordPluginConfigFromInstallation(stored) } : null;
}
