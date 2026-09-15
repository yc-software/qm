import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";

interface ActiveSlackInstallation {
  serviceBlocked?: boolean;
  orgId: string;
  disabled: false;
  botTokenEnc: string;
  appTokenEnc?: string;
  appId?: string;
  installId?: string;
  installedAt?: number;
  teamId?: string;
  teamName?: string;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface DisabledSlackInstallation {
  installedAt?: number;
  serviceBlocked?: boolean;
  orgId: string;
  disabled: true;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

type StoredSlackInstallation = ActiveSlackInstallation | DisabledSlackInstallation;

interface SlackInstallation {
  botToken: string;
  appToken?: string;
  appId?: string;
  installId?: string;
  installedAt?: number;
  teamId?: string;
  teamName?: string;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface SlackInstallationStatus {
  configured: boolean;
  managed: boolean;
  teamId?: string;
  teamName?: string;
  updatedAt?: number;
  updatedBy?: string;
  version?: string;
}

export interface SlackInstallationStore {
  get(): Promise<SlackInstallation | null>;
  status(): Promise<SlackInstallationStatus>;
  set(input: {
    botToken: string;
    appToken?: string;
    appId?: string;
    installId?: string;
    installedAt?: number;
    teamId?: string;
    teamName?: string;
    updatedBy: string;
  }): Promise<SlackInstallationStatus>;
  delete(updatedBy: string): Promise<void>;
  setManaged(input: {
    botToken: string;
    appId: string;
    installId: string;
    installedAt: number;
    teamId: string;
    teamName?: string;
  }): Promise<boolean>;
  disableManaged(installId: string): Promise<boolean>;
  enableManaged(): Promise<boolean>;
}

export function createSlackInstallationStore(
  orgId: string,
  map: DurableMap<StoredSlackInstallation>,
  keyMaterial: Buffer | string,
): SlackInstallationStore {
  const key = deriveConnectorKey(keyMaterial, "slack-installation");
  const publicStatus = (record: StoredSlackInstallation | null): SlackInstallationStatus =>
    record && !record.disabled
      ? {
          configured: true,
          managed: true,
          ...(record.teamId ? { teamId: record.teamId } : {}),
          ...(record.teamName ? { teamName: record.teamName } : {}),
          updatedAt: record.updatedAt,
          updatedBy: record.updatedBy,
          version: record.version,
        }
      : { configured: false, managed: record !== null };
  return {
    async get() {
      const record = await map.get(orgId);
      if (!record || record.disabled) return null;
      return {
        botToken: decryptSecret(record.botTokenEnc, key),
        ...(record.appTokenEnc ? { appToken: decryptSecret(record.appTokenEnc, key) } : {}),
        ...(record.appId ? { appId: record.appId } : {}),
        ...(record.installId ? { installId: record.installId } : {}),
        ...(record.installedAt ? { installedAt: record.installedAt } : {}),
        ...(record.teamId ? { teamId: record.teamId } : {}),
        ...(record.teamName ? { teamName: record.teamName } : {}),
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        version: record.version,
      };
    },
    async status() {
      return publicStatus(await map.get(orgId));
    },
    async set(input) {
      const updatedAt = Date.now();
      const record: StoredSlackInstallation = {
        orgId,
        disabled: false,
        serviceBlocked: true,
        botTokenEnc: encryptSecret(input.botToken, key),
        ...(input.appToken ? { appTokenEnc: encryptSecret(input.appToken, key) } : {}),
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.installId ? { installId: input.installId } : {}),
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamName ? { teamName: input.teamName } : {}),
        updatedAt,
        updatedBy: input.updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.put(orgId, record);
      return publicStatus(record);
    },
    async setManaged(input) {
      if (!map.update) throw new Error("Atomic installation updates are required");
      await map.putIfAbsent(orgId, {
        orgId,
        disabled: true,
        updatedAt: 0,
        updatedBy: "slack-service",
        version: "initial",
      });
      let accepted = false;
      await map.update(orgId, (record) => {
        if (record.serviceBlocked || (!record.disabled && !record.installId)) return record;
        if (!record.disabled && record.installId === input.installId) {
          accepted =
            record.teamId === input.teamId && record.appId === input.appId && record.installedAt === input.installedAt;
          return record;
        }
        if ((record.installedAt ?? 0) >= input.installedAt || (!record.disabled && record.teamId !== input.teamId))
          return record;
        accepted = true;
        return {
          orgId,
          disabled: false,
          botTokenEnc: encryptSecret(input.botToken, key),
          appId: input.appId,
          installId: input.installId,
          installedAt: input.installedAt,
          teamId: input.teamId,
          ...(input.teamName ? { teamName: input.teamName } : {}),
          updatedAt: Date.now(),
          updatedBy: "slack-service",
          version: crypto.randomUUID(),
        };
      });
      return accepted;
    },
    async enableManaged() {
      if (!map.update) throw new Error("Atomic installation updates are required");
      let accepted = true;
      await map.update(orgId, (record) => {
        if (!record.disabled && !record.installId) {
          accepted = false;
          return record;
        }
        return { ...record, serviceBlocked: false };
      });
      return accepted;
    },
    async disableManaged(installId) {
      if (!map.update) throw new Error("Atomic installation updates are required");
      let disabled = false;
      await map.update(orgId, (record) => {
        if (record.disabled || record.installId !== installId) return record;
        disabled = true;
        return {
          orgId,
          disabled: true,
          installedAt: record.installedAt,
          updatedAt: Date.now(),
          updatedBy: "slack-service",
          version: crypto.randomUUID(),
        };
      });
      return disabled;
    },
    async delete(updatedBy) {
      if (map.update) {
        const record = await map.update(orgId, (current) => ({
          orgId,
          disabled: true,
          serviceBlocked: current.serviceBlocked || (!current.disabled && !current.installId),
          ...(current.installedAt ? { installedAt: current.installedAt } : {}),
          updatedAt: Date.now(),
          updatedBy,
          version: crypto.randomUUID(),
        }));
        if (record) return;
      }
      const updatedAt = Date.now();
      await map.put(orgId, {
        orgId,
        disabled: true,
        updatedAt,
        updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      });
    },
  };
}

interface SlackValidationResponse {
  ok?: boolean;
  error?: string;
  team_id?: string;
  team?: string;
  app_id?: string;
  bot_id?: string;
  url?: string;
  bot?: { app_id?: string };
}

export type SlackSocketAppIdReader = (url: string) => Promise<string>;

async function readSlackSocketAppId(url: string): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "wss:" || (target.hostname !== "slack.com" && !target.hostname.endsWith(".slack.com"))) {
    throw new Error("apps.connections.open returned an unexpected WebSocket host");
  }
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(target);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Slack Socket Mode validation timed out"));
    }, 10_000);
    const finish = (error: Error | null, appId?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (closeError) {
        void closeError;
      }
      if (error) reject(error);
      else resolve(appId!);
    };
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; connection_info?: { app_id?: string } };
        if (frame.type !== "hello") return;
        const appId = frame.connection_info?.app_id;
        finish(appId ? null : new Error("Slack Socket Mode hello returned no app_id"), appId);
      } catch {
        finish(new Error("Slack Socket Mode returned an invalid hello frame"));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Slack Socket Mode validation failed")));
    socket.addEventListener("close", () => finish(new Error("Slack Socket Mode closed before validation")));
  });
}

export async function validateSlackInstallation(
  botToken: string,
  appToken: string,
  fetchImpl: typeof fetch = fetch,
  readSocketAppId: SlackSocketAppIdReader = readSlackSocketAppId,
): Promise<{ teamId?: string; teamName?: string }> {
  if (!botToken.startsWith("xoxb-")) throw new Error("bot token must start with xoxb-");
  if (!appToken.startsWith("xapp-")) throw new Error("app token must start with xapp-");
  const call = async (method: string, token: string, formBody = ""): Promise<SlackValidationResponse> => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: formBody,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as SlackValidationResponse;
    if (!response.ok || !payload.ok) throw new Error(`${method} failed: ${payload.error ?? `HTTP ${response.status}`}`);
    return payload;
  };
  const auth = await call("auth.test", botToken);
  let botAppId = auth.app_id;
  if (!botAppId && auth.bot_id) {
    const bot = await call("bots.info", botToken, new URLSearchParams({ bot: auth.bot_id }).toString());
    botAppId = bot.bot?.app_id;
  }
  if (!botAppId) throw new Error("Slack bot identity returned no app_id");
  const connection = await call("apps.connections.open", appToken);
  if (!connection.url) throw new Error("apps.connections.open returned no WebSocket URL");
  const socketAppId = await readSocketAppId(connection.url);
  if (socketAppId !== botAppId) throw new Error("bot token and app token belong to different Slack apps");
  return {
    ...(auth.team_id ? { teamId: auth.team_id } : {}),
    ...(auth.team ? { teamName: auth.team } : {}),
  };
}
