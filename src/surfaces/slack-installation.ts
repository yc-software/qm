import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { ErrorCode } from "@slack/web-api";
import { SLACK_AUTH_ERRORS, slackErrorCode } from "../slack/payloads.ts";
import { slackWebClient, type SlackWebClientFactory } from "../slack/web-client.ts";
import { perTenant, tenant } from "../tenant.ts";

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

const SLACK_INSTALLATION: TableSpec = {
  table: "slack_installation",
  key: "orgId",
  keyIsField: true,
  columns: cols(`disabled boolean!, serviceBlocked boolean, botTokenEnc text, appTokenEnc text, appId text,
    installId text, installedAt bigint, teamId text, teamName text, updatedAt bigint!,
    updatedBy text!, version text!`),
};

export const SLACK_INSTALLATION_MIGRATION = mapToTableMigration(
  "surfaces/slack-installation/0001-typed",
  SLACK_INSTALLATION,
);

export function createSlackInstallationStore(
  databaseUrl: string,
  keyMaterial: () => Buffer | string,
): SlackInstallationStore {
  const keys = perTenant(() => deriveConnectorKey(keyMaterial(), "slack-installation"));
  const pg = createPgPool(databaseUrl, [SLACK_INSTALLATION_MIGRATION]);
  const { get: read, modify } = typedTable<StoredSlackInstallation>(pg, SLACK_INSTALLATION);
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
      const key = keys();
      const record = await read(tenant().orgId);
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
      return publicStatus(await read(tenant().orgId));
    },
    async set(input) {
      const { orgId } = tenant();
      const key = keys();
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
      const stored = await modify(orgId, (current) => ({
        ...record,
        ...(current?.installedAt !== undefined ? { installedAt: current.installedAt } : {}),
      }));
      if (!stored) throw new Error("Slack installation disappeared during update");
      return publicStatus(stored);
    },
    async setManaged(input) {
      const { orgId } = tenant();
      const key = keys();
      let accepted = false;
      await modify(orgId, (current) => {
        const record: StoredSlackInstallation = current ?? {
          orgId,
          disabled: true,
          updatedAt: 0,
          updatedBy: "slack-service",
          version: "initial",
        };
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
      let accepted = true;
      await modify(tenant().orgId, (record) => {
        if (!record) return null;
        if (!record.disabled && !record.installId) {
          accepted = false;
          return record;
        }
        return { ...record, serviceBlocked: false };
      });
      return accepted;
    },
    async disableManaged(installId) {
      const { orgId } = tenant();
      let disabled = false;
      await modify(orgId, (record) => {
        if (!record || record.disabled || record.installId !== installId) return record;
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
      const { orgId } = tenant();
      await modify(orgId, (current) => {
        const updatedAt = Date.now();
        if (!current)
          return { orgId, disabled: true, updatedAt, updatedBy, version: `${updatedAt}:${crypto.randomUUID()}` };
        return {
          orgId,
          disabled: true,
          serviceBlocked: current.serviceBlocked || (!current.disabled && !current.installId),
          ...(current.installedAt ? { installedAt: current.installedAt } : {}),
          updatedAt,
          updatedBy,
          version: crypto.randomUUID(),
        };
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
  clientFactory?: SlackWebClientFactory,
  readSocketAppId: SlackSocketAppIdReader = readSlackSocketAppId,
): Promise<{ teamId?: string; teamName?: string }> {
  if (!botToken.startsWith("xoxb-"))
    throw new Error(
      "Bot token must start with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions after installing the app.",
    );
  if (!appToken.startsWith("xapp-"))
    throw new Error(
      "App token must start with xapp-. Generate an App-Level Token in Basic Information with connections:write.",
    );
  const call = async (
    method: string,
    token: string,
    args: Record<string, unknown> = {},
  ): Promise<SlackValidationResponse> => {
    const label = method === "apps.connections.open" ? "App-level token" : "Bot token";
    const outcome = await slackWebClient(token, clientFactory, 10_000)
      .apiCall(method, args)
      .then(
        (value) => ({ value: value as SlackValidationResponse }),
        (error: unknown) => ({ error }),
      );
    if ("value" in outcome) return outcome.value;
    const { error } = outcome;
    const failure = error as { code?: unknown; retryAfter?: unknown; statusCode?: unknown };
    if (failure.code === ErrorCode.RateLimitedError) {
      const seconds = Number(failure.retryAfter);
      throw new Error(
        `Slack is temporarily rate-limiting validation. Try again${seconds > 0 && Number.isFinite(seconds) ? ` in ${Math.ceil(seconds)} seconds` : " shortly"}. Your existing connection has not changed.`,
      );
    }
    if (failure.code !== ErrorCode.PlatformError && failure.code !== ErrorCode.HTTPError) throw error;
    const code = slackErrorCode(error);
    if (SLACK_AUTH_ERRORS.has(code ?? ""))
      throw new Error(
        `${label} was rejected by Slack. Copy a current token from the same installed Slack app and try again.`,
      );
    if (code === "missing_scope")
      throw new Error(
        method === "apps.connections.open"
          ? "App-level token needs connections:write. Generate a new token in Basic Information with that scope."
          : "Bot token is missing permissions. Apply the provided manifest and reinstall the app in OAuth & Permissions.",
      );
    if (code === "not_allowed_token_type")
      throw new Error(
        `${label} has the wrong token type. Use the Bot User OAuth Token (xoxb-) and App-Level Token (xapp-) from the setup guide.`,
      );
    throw new Error(
      `${label} validation failed (${code ?? `HTTP ${String(failure.statusCode)}`}). Check that the app is installed and Socket Mode is enabled, then try again.`,
    );
  };
  const auth = await call("auth.test", botToken);
  let botAppId = auth.app_id;
  if (!botAppId && auth.bot_id) {
    const bot = await call("bots.info", botToken, { bot: auth.bot_id });
    botAppId = bot.bot?.app_id;
  }
  if (!botAppId) throw new Error("Slack bot identity returned no app_id");
  const connection = await call("apps.connections.open", appToken);
  if (!connection.url) throw new Error("apps.connections.open returned no WebSocket URL");
  const socketAppId = await readSocketAppId(connection.url);
  if (socketAppId !== botAppId)
    throw new Error(
      "The bot token and app token belong to different Slack apps. Copy both tokens from the same app; your existing connection has not changed.",
    );
  return {
    ...(auth.team_id ? { teamId: auth.team_id } : {}),
    ...(auth.team ? { teamName: auth.team } : {}),
  };
}
