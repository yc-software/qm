import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App as BoltApp, Receiver } from "@slack/bolt";
import { isValidSlackRequest } from "@slack/bolt";
import type { DurableMap } from "../persistence/durable-map.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import {
  createEncryptedSecretStore,
  deleteReplacedSecrets,
  type SecretStoreFactory,
} from "../credentials/secret-store.ts";
import { SLACK_AUTH_ERRORS } from "../slack/payloads.ts";
import type { EnvelopeStaging } from "../slack/envelope-staging.ts";
import {
  createDeferredEnvelopeAck,
  describeEnvelope,
  envelopeStageFor,
  isGatedEnvelope,
} from "../slack/deferred-ack.ts";
import { sendJson } from "../api/http.ts";
import { swallow } from "../util/errors.ts";
import { buildSlackAppManifest, slackBotManifestCreationUrl, slackOAuthAuthorizeUrl } from "./slack-manifest.ts";

const MAX_EVENT_BODY_BYTES = 5 * 1024 * 1024;
const CONFIG_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const BASE_TARGET = "base";

interface ActiveSlackInstallation {
  kind?: "installation";
  serviceBlocked?: boolean;
  orgId: string;
  personaId?: string;
  disabled: false;
  pending?: boolean;
  botTokenEnc?: string;
  appTokenEnc?: string;
  signingSecretEnc?: string;
  clientId?: string;
  clientSecretEnc?: string;
  oauthState?: string;
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
  kind?: "installation";
  installedAt?: number;
  serviceBlocked?: boolean;
  orgId: string;
  personaId?: string;
  disabled: true;
  updatedAt: number;
  updatedBy: string;
  version: string;
}

interface StoredSlackConfigToken {
  kind: "config-token";
  orgId: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  expiresAt?: number;
  updatedAt: number;
  updatedBy: string;
}

export type StoredSlackInstallation = ActiveSlackInstallation | DisabledSlackInstallation | StoredSlackConfigToken;

interface SlackInstallation {
  personaId?: string;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
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

interface SlackConfigTokenStatus {
  configured: boolean;
  hasRefreshToken: boolean;
  expiresAt?: number;
  updatedAt?: number;
  updatedBy?: string;
}

interface SlackAppProvisionStatus {
  status: "unconnected" | "pending_install" | "connected";
  appId?: string;
  teamId?: string;
  teamName?: string;
  oauthAuthorizeUrl?: string;
  hasOrgConfigToken: boolean;
  publicUrlConfigured: boolean;
  manifestCreateUrl: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface SlackInstallationStore {
  get(): Promise<SlackInstallation | null>;
  status(): Promise<SlackInstallationStatus>;
  set(input: {
    botToken: string;
    appToken?: string;
    signingSecret?: string;
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
  onSet(listener: () => void): void;

  configTokenStatus(): Promise<SlackConfigTokenStatus>;
  setConfigToken(input: {
    accessToken?: string;
    refreshToken?: string;
    updatedBy: string;
  }): Promise<SlackConfigTokenStatus>;
  deleteConfigToken(): Promise<void>;

  appStatus(personaId?: string, displayName?: string): Promise<SlackAppProvisionStatus>;
  createApp(input: {
    personaId?: string;
    name: string;
    description?: string;
    configToken?: string;
    saveOrgConfigToken?: boolean;
    orgDeploy?: boolean;
    updatedBy: string;
  }): Promise<{ status: SlackAppProvisionStatus; oauthAuthorizeUrl: string; appId: string }>;
  completeOAuth(input: {
    code: string;
    state: string;
  }): Promise<{ personaId?: string; appId?: string; teamId?: string; teamName?: string }>;
  attachHttpApp(input: {
    personaId?: string;
    botToken: string;
    signingSecret: string;
    appId?: string;
    updatedBy: string;
  }): Promise<SlackAppProvisionStatus>;
  deleteApp(input: {
    personaId?: string;
    updatedBy: string;
    deleteRemote?: boolean;
    configToken?: string;
  }): Promise<void>;
  listPersonaApps(): Promise<SlackInstallation[]>;

  receiver(target: string, signingSecret: string, staging?: EnvelopeStaging): Receiver;
  handleHttpEvent(target: string, req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface SlackApiResult {
  ok?: boolean;
  error?: string;
  errors?: Array<{ message?: string; pointer?: string }>;
  token?: string;
  refresh_token?: string;
  exp?: number;
  app_id?: string;
  credentials?: {
    client_id?: string;
    client_secret?: string;
    signing_secret?: string;
  };
  access_token?: string;
  team?: { id?: string; name?: string } | string;
  team_id?: string;
  oauth_authorize_url?: string;
}

function isInstallationRecord(
  record: StoredSlackInstallation | null | undefined,
): record is ActiveSlackInstallation | DisabledSlackInstallation {
  return Boolean(record && record.kind !== "config-token");
}

function isActiveConnected(record: StoredSlackInstallation | null | undefined): record is ActiveSlackInstallation {
  return isInstallationRecord(record) && !record.disabled && !record.pending && Boolean(record.botTokenEnc);
}

function formatSlackError(method: string, data: SlackApiResult): string {
  const details = data.errors
    ?.map((e) => (e.pointer ? `${e.pointer}: ${e.message ?? ""}` : (e.message ?? "")))
    .filter(Boolean)
    .join("; ");
  return details ? `${method}: ${data.error ?? "unknown"} (${details})` : `${method}: ${data.error ?? "unknown"}`;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSlackPayload(rawBody: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload");
    if (payload) return JSON.parse(payload) as Record<string, unknown>;
    return Object.fromEntries(params.entries());
  }
  return JSON.parse(rawBody) as Record<string, unknown>;
}

export function createSlackInstallationStore(
  orgId: string,
  map: DurableMap<StoredSlackInstallation>,
  keyMaterial: Buffer | string,
  opts?: { publicUrl?: string; fetchImpl?: typeof fetch; secrets?: SecretStoreFactory },
): SlackInstallationStore {
  const secrets = (opts?.secrets ?? createEncryptedSecretStore)(deriveConnectorKey(keyMaterial, "slack-installation"));
  const secretName = (slot: string, personaId?: string) =>
    `slack-installation/${orgId}/${personaId ? `persona-${personaId}/` : ""}${slot}`;
  const liveInstallSecrets = (record: StoredSlackInstallation | null | undefined) =>
    isInstallationRecord(record) && !record.disabled
      ? [record.botTokenEnc, record.appTokenEnc, record.signingSecretEnc, record.clientSecretEnc]
      : [];
  const liveConfigSecrets = (record: StoredSlackConfigToken | null | undefined) =>
    record ? [record.accessTokenEnc, record.refreshTokenEnc] : [];
  const deleteDroppedInstallSecrets = (
    previous: StoredSlackInstallation | null | undefined,
    next: StoredSlackInstallation | null | undefined,
    written: readonly (string | undefined)[] = [],
  ) => deleteReplacedSecrets(secrets, [...written, ...liveInstallSecrets(previous)], liveInstallSecrets(next));
  const putConfigToken = async (
    record: StoredSlackConfigToken,
    previous?: StoredSlackConfigToken | null,
  ): Promise<void> => {
    const prior = previous === undefined ? await getStoredConfigToken() : previous;
    await map.put(configTokenKey, record);
    await deleteReplacedSecrets(secrets, liveConfigSecrets(prior), liveConfigSecrets(record));
  };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const baseUrl = opts?.publicUrl?.replace(/\/+$/, "");

  const personaPrefix = `${orgId}:persona:`;
  const configTokenKey = `${orgId}:config-token`;
  const keyFor = (personaId?: string) => (personaId ? `${personaPrefix}${personaId}` : orgId);
  const targetFor = (personaId?: string) => personaId ?? BASE_TARGET;
  const eventsUrlFor = (personaId?: string) =>
    baseUrl ? `${baseUrl}/slack/events/app/${encodeURIComponent(targetFor(personaId))}` : undefined;
  const oauthCallbackUrl = () => (baseUrl ? `${baseUrl}/v1/slack/oauth/callback` : undefined);

  const setListeners = new Set<() => void>();
  const notifySet = () => {
    for (const listener of setListeners) listener();
  };

  const pendingVerifications = new Set<string>();
  type ActiveReceiver = { app: BoltApp; signingSecret: string; staging?: EnvelopeStaging };
  const activeReceivers = new Map<string, ActiveReceiver>();

  const callSlack = async (
    method: string,
    token: string | undefined,
    body?: Record<string, unknown> | string,
    form = false,
  ): Promise<SlackApiResult> => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8";
    }
    let payload = "";
    if (typeof body === "string") payload = body;
    else if (body !== undefined) payload = JSON.stringify(body);
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers,
      ...(body !== undefined ? { body: payload } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as SlackApiResult;
    if (!res.ok || !data.ok) throw new Error(formatSlackError(method, data));
    return data;
  };

  const rotateRefreshToken = async (
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> => {
    const data = await callSlack(
      "tooling.tokens.rotate",
      undefined,
      new URLSearchParams({ refresh_token: refreshToken }).toString(),
      true,
    );
    if (!data.token || !data.refresh_token) {
      throw new Error("tooling.tokens.rotate returned no rotated tokens");
    }
    return {
      accessToken: data.token,
      refreshToken: data.refresh_token,
      expiresAt: typeof data.exp === "number" ? data.exp * 1000 : Date.now() + 12 * 3600_000,
    };
  };

  const getStoredConfigToken = async (): Promise<StoredSlackConfigToken | null> => {
    const rec = await map.get(configTokenKey);
    return rec && rec.kind === "config-token" ? rec : null;
  };

  const resolveConfigAccessToken = async (
    explicitToken: string | undefined,
    saveToOrg: boolean,
    updatedBy: string,
  ): Promise<string> => {
    const trimmed = explicitToken?.trim();
    if (trimmed) {
      if (trimmed.startsWith("xoxe-")) {
        const rotated = await rotateRefreshToken(trimmed);
        if (saveToOrg) {
          const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
            secrets.put(secretName("config-access"), rotated.accessToken),
            secrets.put(secretName("config-refresh"), rotated.refreshToken),
          ]);
          await putConfigToken({
            kind: "config-token",
            orgId,
            accessTokenEnc,
            refreshTokenEnc,
            expiresAt: rotated.expiresAt,
            updatedAt: Date.now(),
            updatedBy,
          });
        }
        return rotated.accessToken;
      }
      if (trimmed.startsWith("xoxe.xoxp-")) {
        if (saveToOrg) {
          const accessTokenEnc = await secrets.put(secretName("config-access"), trimmed);
          await putConfigToken({
            kind: "config-token",
            orgId,
            accessTokenEnc,
            expiresAt: Date.now() + 11 * 3600_000,
            updatedAt: Date.now(),
            updatedBy,
          });
        }
        return trimmed;
      }
      throw new Error(
        "Slack App Configuration Token must be a Refresh Token (xoxe-1-…) or Access Token (xoxe.xoxp-…) from api.slack.com/apps.",
      );
    }
    const stored = await getStoredConfigToken();
    if (!stored) {
      throw new Error(
        "No Slack App Configuration Token is configured. Generate one at https://api.slack.com/apps (Your App Configuration Tokens) and provide the Refresh Token (xoxe-1-…).",
      );
    }
    const hasFreshAccess =
      stored.accessTokenEnc && stored.expiresAt && stored.expiresAt - Date.now() > CONFIG_TOKEN_REFRESH_BUFFER_MS;
    if (hasFreshAccess) return secrets.get(stored.accessTokenEnc!);
    if (stored.refreshTokenEnc) {
      const rotated = await rotateRefreshToken(await secrets.get(stored.refreshTokenEnc));
      const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
        secrets.put(secretName("config-access"), rotated.accessToken),
        secrets.put(secretName("config-refresh"), rotated.refreshToken),
      ]);
      await putConfigToken(
        {
          kind: "config-token",
          orgId,
          accessTokenEnc,
          refreshTokenEnc,
          expiresAt: rotated.expiresAt,
          updatedAt: Date.now(),
          updatedBy,
        },
        stored,
      );
      return rotated.accessToken;
    }
    if (stored.accessTokenEnc) return secrets.get(stored.accessTokenEnc);
    throw new Error(
      "Stored Slack App Configuration Token is expired; generate a new one at https://api.slack.com/apps.",
    );
  };

  const decryptInstallation = async (record: ActiveSlackInstallation): Promise<SlackInstallation> => {
    const [botToken, appToken, signingSecret] = await Promise.all([
      secrets.get(record.botTokenEnc!),
      record.appTokenEnc ? secrets.get(record.appTokenEnc) : Promise.resolve(undefined),
      record.signingSecretEnc ? secrets.get(record.signingSecretEnc) : Promise.resolve(undefined),
    ]);
    return {
      ...(record.personaId ? { personaId: record.personaId } : {}),
      botToken,
      ...(appToken ? { appToken } : {}),
      ...(signingSecret ? { signingSecret } : {}),
      ...(record.appId ? { appId: record.appId } : {}),
      ...(record.installId ? { installId: record.installId } : {}),
      ...(record.installedAt ? { installedAt: record.installedAt } : {}),
      ...(record.teamId ? { teamId: record.teamId } : {}),
      ...(record.teamName ? { teamName: record.teamName } : {}),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      version: record.version,
    };
  };

  const publicStatus = (record: StoredSlackInstallation | null): SlackInstallationStatus => {
    if (isActiveConnected(record)) {
      return {
        configured: true,
        managed: true,
        ...(record.teamId ? { teamId: record.teamId } : {}),
        ...(record.teamName ? { teamName: record.teamName } : {}),
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        version: record.version,
      };
    }
    return { configured: false, managed: isInstallationRecord(record) };
  };

  const toProvisionStatus = async (
    record: StoredSlackInstallation | null,
    displayName?: string,
  ): Promise<SlackAppProvisionStatus> => {
    const cfg = await getStoredConfigToken();
    const hasOrgConfigToken = Boolean(cfg?.refreshTokenEnc || cfg?.accessTokenEnc);
    const manifestCreateUrl = slackBotManifestCreationUrl(displayName);
    const redirectUri = oauthCallbackUrl();
    if (!isInstallationRecord(record) || record.disabled) {
      return {
        status: "unconnected",
        hasOrgConfigToken,
        publicUrlConfigured: Boolean(baseUrl),
        manifestCreateUrl,
      };
    }
    if (record.pending) {
      const oauthAuthorizeUrl =
        record.clientId && record.oauthState && redirectUri
          ? slackOAuthAuthorizeUrl(record.clientId, redirectUri, record.oauthState)
          : undefined;
      return {
        status: "pending_install",
        ...(record.appId ? { appId: record.appId } : {}),
        ...(oauthAuthorizeUrl ? { oauthAuthorizeUrl } : {}),
        hasOrgConfigToken,
        publicUrlConfigured: Boolean(baseUrl),
        manifestCreateUrl,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      };
    }
    return {
      status: "connected",
      ...(record.appId ? { appId: record.appId } : {}),
      ...(record.teamId ? { teamId: record.teamId } : {}),
      ...(record.teamName ? { teamName: record.teamName } : {}),
      hasOrgConfigToken,
      publicUrlConfigured: Boolean(baseUrl),
      manifestCreateUrl,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  };

  return {
    onSet(listener) {
      setListeners.add(listener);
    },

    async get() {
      const record = await map.get(orgId);
      if (!isActiveConnected(record)) return null;
      return await decryptInstallation(record);
    },

    async status() {
      return publicStatus(await map.get(orgId));
    },

    async set(input) {
      const updatedAt = Date.now();
      const [botTokenEnc, appTokenEnc, signingSecretEnc] = await Promise.all([
        secrets.put(secretName("bot"), input.botToken),
        input.appToken ? secrets.put(secretName("app"), input.appToken) : Promise.resolve(undefined),
        input.signingSecret
          ? secrets.put(secretName("signing-secret"), input.signingSecret)
          : Promise.resolve(undefined),
      ]);
      const record: ActiveSlackInstallation = {
        kind: "installation",
        orgId,
        disabled: false,
        serviceBlocked: true,
        botTokenEnc,
        ...(appTokenEnc ? { appTokenEnc } : {}),
        ...(signingSecretEnc ? { signingSecretEnc } : {}),
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.installId ? { installId: input.installId } : {}),
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamName ? { teamName: input.teamName } : {}),
        updatedAt,
        updatedBy: input.updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.putIfAbsent(orgId, record);
      let previous: StoredSlackInstallation | undefined;
      const stored = await map.update(orgId, (current) => {
        previous = current;
        return {
          ...record,
          ...(isInstallationRecord(current) && current.installedAt !== undefined
            ? { installedAt: current.installedAt }
            : {}),
        };
      });
      if (!stored) throw new Error("Slack installation disappeared during update");
      await deleteDroppedInstallSecrets(previous, stored, [botTokenEnc, appTokenEnc, signingSecretEnc]);
      notifySet();
      return publicStatus(stored);
    },

    async setManaged(input) {
      const botTokenEnc = await secrets.put(secretName("bot"), input.botToken);
      await map.putIfAbsent(orgId, {
        kind: "installation",
        orgId,
        disabled: true,
        updatedAt: 0,
        updatedBy: "slack-service",
        version: "initial",
      });
      let accepted = false;
      let previous: StoredSlackInstallation | undefined;
      const stored = await map.update(orgId, (record) => {
        previous = record;
        if (!isInstallationRecord(record)) return record;
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
          kind: "installation",
          orgId,
          disabled: false,
          botTokenEnc,
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
      await deleteDroppedInstallSecrets(previous, stored, [botTokenEnc]);
      return accepted;
    },

    async enableManaged() {
      let accepted = true;
      await map.update(orgId, (record) => {
        if (!isInstallationRecord(record)) return record;
        if (!record.disabled && !record.installId) {
          accepted = false;
          return record;
        }
        return { ...record, serviceBlocked: false };
      });
      return accepted;
    },

    async disableManaged(installId) {
      let disabled = false;
      let previous: StoredSlackInstallation | undefined;
      const stored = await map.update(orgId, (record) => {
        if (!isInstallationRecord(record) || record.disabled || record.installId !== installId) return record;
        disabled = true;
        previous = record;
        return {
          kind: "installation",
          orgId,
          disabled: true,
          installedAt: record.installedAt,
          updatedAt: Date.now(),
          updatedBy: "slack-service",
          version: crypto.randomUUID(),
        };
      });
      if (disabled) await deleteDroppedInstallSecrets(previous, stored);
      return disabled;
    },

    async delete(updatedBy) {
      let previous: StoredSlackInstallation | undefined;
      const record = await map.update(orgId, (current) => {
        previous = current;
        const inst = isInstallationRecord(current) ? current : null;
        return {
          kind: "installation",
          orgId,
          disabled: true,
          serviceBlocked: inst?.serviceBlocked || Boolean(inst && !inst.disabled && !inst.installId),
          ...(inst?.installedAt ? { installedAt: inst.installedAt } : {}),
          updatedAt: Date.now(),
          updatedBy,
          version: crypto.randomUUID(),
        };
      });
      if (record) {
        await deleteDroppedInstallSecrets(previous, record);
        notifySet();
        return;
      }
      const updatedAt = Date.now();
      await map.put(orgId, {
        kind: "installation",
        orgId,
        disabled: true,
        updatedAt,
        updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      });
      notifySet();
    },

    async configTokenStatus() {
      const rec = await getStoredConfigToken();
      if (!rec) return { configured: false, hasRefreshToken: false };
      return {
        configured: Boolean(rec.refreshTokenEnc || rec.accessTokenEnc),
        hasRefreshToken: Boolean(rec.refreshTokenEnc),
        ...(rec.expiresAt ? { expiresAt: rec.expiresAt } : {}),
        updatedAt: rec.updatedAt,
        updatedBy: rec.updatedBy,
      };
    },

    async setConfigToken(input) {
      const refresh = input.refreshToken?.trim();
      const access = input.accessToken?.trim();
      if (!refresh && !access)
        throw new Error("Provide a Slack App Configuration refreshToken (xoxe-1-…) or accessToken (xoxe.xoxp-…).");
      let accessToken = access;
      let refreshToken = refresh;
      let expiresAt = Date.now() + 11 * 3600_000;
      if (refresh) {
        if (!refresh.startsWith("xoxe-"))
          throw new Error("Slack App Configuration refresh token must start with xoxe-.");
        const rotated = await rotateRefreshToken(refresh);
        accessToken = rotated.accessToken;
        refreshToken = rotated.refreshToken;
        expiresAt = rotated.expiresAt;
      } else if (accessToken && !accessToken.startsWith("xoxe.xoxp-")) {
        throw new Error("Slack App Configuration access token must start with xoxe.xoxp-.");
      }
      const updatedAt = Date.now();
      const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
        accessToken ? secrets.put(secretName("config-access"), accessToken) : Promise.resolve(undefined),
        refreshToken ? secrets.put(secretName("config-refresh"), refreshToken) : Promise.resolve(undefined),
      ]);
      await putConfigToken({
        kind: "config-token",
        orgId,
        ...(accessTokenEnc ? { accessTokenEnc } : {}),
        ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
        expiresAt,
        updatedAt,
        updatedBy: input.updatedBy,
      });
      return {
        configured: true,
        hasRefreshToken: Boolean(refreshToken),
        expiresAt,
        updatedAt,
        updatedBy: input.updatedBy,
      };
    },

    async deleteConfigToken() {
      const prior = await getStoredConfigToken();
      await map.delete(configTokenKey);
      await deleteReplacedSecrets(secrets, liveConfigSecrets(prior), []);
    },

    async appStatus(personaId, displayName) {
      return toProvisionStatus(await map.get(keyFor(personaId)), displayName);
    },

    async createApp(input) {
      const eventsUrl = eventsUrlFor(input.personaId);
      const redirectUri = oauthCallbackUrl();
      if (!eventsUrl || !redirectUri) {
        throw new Error("PUBLIC_WEB_URL must be configured to create Slack apps automatically.");
      }
      const accessToken = await resolveConfigAccessToken(
        input.configToken,
        Boolean(input.saveOrgConfigToken),
        input.updatedBy,
      );
      const manifest = buildSlackAppManifest({
        name: input.name,
        description: input.description,
        eventsUrl,
        redirectUrl: redirectUri,
        orgDeploy: input.orgDeploy,
      });
      const target = targetFor(input.personaId);
      pendingVerifications.add(target);
      let created: SlackApiResult;
      try {
        created = await callSlack("apps.manifest.create", accessToken, { manifest: JSON.stringify(manifest) });
      } finally {
        pendingVerifications.delete(target);
      }
      const appId = created.app_id;
      const creds = created.credentials;
      if (!appId || !creds?.client_id || !creds.client_secret || !creds.signing_secret) {
        throw new Error("apps.manifest.create returned incomplete app credentials");
      }
      const oauthState = `${target}.${randomBytes(24).toString("hex")}`;
      const updatedAt = Date.now();
      const [clientSecretEnc, signingSecretEnc] = await Promise.all([
        secrets.put(secretName("client-secret", input.personaId), creds.client_secret),
        secrets.put(secretName("signing-secret", input.personaId), creds.signing_secret),
      ]);
      const storageKey = keyFor(input.personaId);
      const previous = await map.get(storageKey);
      const record: ActiveSlackInstallation = {
        kind: "installation",
        orgId,
        ...(input.personaId ? { personaId: input.personaId } : {}),
        disabled: false,
        pending: true,
        serviceBlocked: true,
        appId,
        clientId: creds.client_id,
        clientSecretEnc,
        signingSecretEnc,
        oauthState,
        updatedAt,
        updatedBy: input.updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.put(storageKey, record);
      await deleteDroppedInstallSecrets(previous, record);
      const oauthAuthorizeUrl = slackOAuthAuthorizeUrl(creds.client_id, redirectUri, oauthState);
      const status = await toProvisionStatus(record, input.name);
      return { status, oauthAuthorizeUrl, appId };
    },

    async completeOAuth(input) {
      const redirectUri = oauthCallbackUrl();
      if (!redirectUri) throw new Error("PUBLIC_WEB_URL is not configured.");
      const dot = input.state.indexOf(".");
      if (dot <= 0) throw new Error("Invalid OAuth state");
      const target = input.state.slice(0, dot);
      const personaId = target === BASE_TARGET ? undefined : target;
      const storageKey = keyFor(personaId);
      const rec = await map.get(storageKey);
      if (
        !isInstallationRecord(rec) ||
        rec.disabled ||
        !rec.oauthState ||
        rec.oauthState !== input.state ||
        !rec.clientId ||
        !rec.clientSecretEnc
      ) {
        throw new Error("OAuth state mismatch or no pending Slack app install found.");
      }
      const exchanged = await callSlack(
        "oauth.v2.access",
        undefined,
        new URLSearchParams({
          client_id: rec.clientId,
          client_secret: await secrets.get(rec.clientSecretEnc),
          code: input.code,
          redirect_uri: redirectUri,
        }).toString(),
        true,
      );
      const botToken = exchanged.access_token;
      if (!botToken || !botToken.startsWith("xoxb-")) {
        throw new Error("Slack OAuth did not return a bot token (xoxb-).");
      }
      const teamObj = typeof exchanged.team === "object" && exchanged.team ? exchanged.team : undefined;
      const teamId = teamObj?.id ?? exchanged.team_id;
      const teamName = teamObj?.name ?? (typeof exchanged.team === "string" ? exchanged.team : undefined);
      const updatedAt = Date.now();
      const botTokenEnc = await secrets.put(secretName("bot", personaId), botToken);
      const updated: ActiveSlackInstallation = {
        ...rec,
        pending: false,
        botTokenEnc,
        ...(teamId ? { teamId } : {}),
        ...(teamName ? { teamName } : {}),
        updatedAt,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      delete updated.oauthState;
      await map.put(storageKey, updated);
      await deleteDroppedInstallSecrets(rec, updated);
      notifySet();
      return {
        ...(personaId ? { personaId } : {}),
        ...(rec.appId ? { appId: rec.appId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(teamName ? { teamName } : {}),
      };
    },

    async attachHttpApp(input) {
      const botToken = input.botToken.trim();
      const signingSecret = input.signingSecret.trim();
      if (!botToken.startsWith("xoxb-")) throw new Error("Bot token must start with xoxb-.");
      if (!signingSecret) throw new Error("Signing secret is required.");
      const auth = await callSlack("auth.test", botToken);
      const teamId = auth.team_id;
      const teamName = typeof auth.team === "string" ? auth.team : undefined;
      const appId = input.appId?.trim() || auth.app_id;
      const updatedAt = Date.now();
      const [botTokenEnc, signingSecretEnc] = await Promise.all([
        secrets.put(secretName("bot", input.personaId), botToken),
        secrets.put(secretName("signing-secret", input.personaId), signingSecret),
      ]);
      const storageKey = keyFor(input.personaId);
      const previous = await map.get(storageKey);
      const record: ActiveSlackInstallation = {
        kind: "installation",
        orgId,
        ...(input.personaId ? { personaId: input.personaId } : {}),
        disabled: false,
        pending: false,
        serviceBlocked: true,
        botTokenEnc,
        signingSecretEnc,
        ...(appId ? { appId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(teamName ? { teamName } : {}),
        updatedAt,
        updatedBy: input.updatedBy,
        version: `${updatedAt}:${crypto.randomUUID()}`,
      };
      await map.put(storageKey, record);
      await deleteDroppedInstallSecrets(previous, record);
      notifySet();
      return toProvisionStatus(record);
    },

    async deleteApp(input) {
      const storageKey = keyFor(input.personaId);
      const rec = await map.get(storageKey);
      if (input.deleteRemote && isInstallationRecord(rec) && !rec.disabled && rec.appId) {
        const accessToken = await resolveConfigAccessToken(input.configToken, false, input.updatedBy);
        await callSlack("apps.manifest.delete", accessToken, { app_id: rec.appId });
      }
      if (!input.personaId) {
        await this.delete(input.updatedBy);
        return;
      }
      await map.delete(storageKey);
      await deleteDroppedInstallSecrets(rec, null);
      notifySet();
    },

    async listPersonaApps() {
      const entries = await map.entries();
      const active = entries
        .filter(([k, rec]) => k.startsWith(personaPrefix) && isActiveConnected(rec))
        .map(([, rec]) => rec as ActiveSlackInstallation);
      return Promise.all(active.map(decryptInstallation));
    },

    receiver(target, signingSecret, staging) {
      let instance: ActiveReceiver | undefined;
      return {
        init(app) {
          instance = { app, signingSecret, staging };
        },
        async start() {
          if (instance) activeReceivers.set(target, instance);
        },
        async stop() {
          if (instance && activeReceivers.get(target) === instance) activeReceivers.delete(target);
        },
      } as Receiver;
    },

    async handleHttpEvent(target, req, res) {
      let rawBody: string;
      try {
        rawBody = await readRawBody(req, MAX_EVENT_BODY_BYTES);
      } catch {
        return sendJson(res, 413, { error: "payload_too_large" });
      }
      const contentType = String(req.headers["content-type"] ?? "");
      let payload: Record<string, unknown>;
      try {
        payload = parseSlackPayload(rawBody, contentType);
      } catch {
        return sendJson(res, 400, { error: "invalid_payload" });
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        if (pendingVerifications.has(target)) {
          return sendJson(res, 200, { challenge: payload.challenge });
        }
      }
      const active = activeReceivers.get(target);
      let signingSecret = active?.signingSecret;
      if (!signingSecret) {
        const stored = await map.get(keyFor(target === BASE_TARGET ? undefined : target));
        if (isInstallationRecord(stored) && !stored.disabled && stored.signingSecretEnc) {
          signingSecret = await secrets.get(stored.signingSecretEnc);
        }
      }
      if (!signingSecret) return sendJson(res, 404, { error: "not_configured" });
      const tsHeader = req.headers["x-slack-request-timestamp"];
      const sigHeader = req.headers["x-slack-signature"];
      if (
        typeof tsHeader !== "string" ||
        typeof sigHeader !== "string" ||
        !isValidSlackRequest({
          signingSecret,
          body: rawBody,
          headers: {
            "x-slack-signature": sigHeader,
            "x-slack-request-timestamp": Number(tsHeader),
          },
        })
      ) {
        return sendJson(res, 401, { error: "invalid_signature" });
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        return sendJson(res, 200, { challenge: payload.challenge });
      }
      if (!active) return sendJson(res, 503, { error: "slack_app_not_ready" });
      const retryNumHeader = req.headers["x-slack-retry-num"];
      const retryNum = typeof retryNumHeader === "string" && retryNumHeader !== "" ? Number(retryNumHeader) : undefined;
      const retryReason =
        typeof req.headers["x-slack-retry-reason"] === "string" ? req.headers["x-slack-retry-reason"] : undefined;
      await new Promise<void>((resolve) => {
        let replied = false;
        const respond = (status: number, body: unknown): void => {
          if (replied) return;
          replied = true;
          if (typeof body === "string") {
            res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
            res.end(body);
          } else {
            sendJson(res, status, body ?? {});
          }
          resolve();
        };
        const { ack, gate } = createDeferredEnvelopeAck(async (ackPayload) => respond(200, ackPayload ?? {}), {
          gated: isGatedEnvelope(payload),
          label: describeEnvelope(payload),
          onWithhold: () => respond(503, { error: "not_persisted" }),
          ...envelopeStageFor(active.staging, payload),
        });
        void active.app
          .processEvent({
            body: payload,
            ack,
            ...(retryNum !== undefined && Number.isFinite(retryNum) ? { retryNum } : {}),
            ...(retryReason ? { retryReason } : {}),
            customProperties: { ackGate: gate },
          })
          .then(
            () => gate.persisted(),
            (e: unknown) => {
              swallow("slack-http: process event", e);
              gate.failed("delivery failed");
            },
          );
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
  if (!botToken.startsWith("xoxb-"))
    throw new Error(
      "Bot token must start with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions after installing the app.",
    );
  if (!appToken.startsWith("xapp-"))
    throw new Error(
      "App token must start with xapp-. Generate an App-Level Token in Basic Information with connections:write.",
    );
  const call = async (method: string, token: string, formBody = ""): Promise<SlackValidationResponse> => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: formBody,
      signal: AbortSignal.timeout(10_000),
    });
    const label = method === "apps.connections.open" ? "App-level token" : "Bot token";
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new Error(
        `Slack is temporarily rate-limiting validation. Try again${seconds > 0 && Number.isFinite(seconds) ? ` in ${Math.ceil(seconds)} seconds` : " shortly"}. Your existing connection has not changed.`,
      );
    }
    const payload = (await response.json()) as SlackValidationResponse;
    if (!response.ok || !payload.ok) {
      if (SLACK_AUTH_ERRORS.has(payload.error ?? ""))
        throw new Error(
          `${label} was rejected by Slack. Copy a current token from the same installed Slack app and try again.`,
        );
      if (payload.error === "missing_scope")
        throw new Error(
          method === "apps.connections.open"
            ? "App-level token needs connections:write. Generate a new token in Basic Information with that scope."
            : "Bot token is missing permissions. Apply the provided manifest and reinstall the app in OAuth & Permissions.",
        );
      if (payload.error === "not_allowed_token_type")
        throw new Error(
          `${label} has the wrong token type. Use the Bot User OAuth Token (xoxb-) and App-Level Token (xapp-) from the setup guide.`,
        );
      throw new Error(
        `${label} validation failed (${payload.error ?? `HTTP ${response.status}`}). Check that the app is installed and Socket Mode is enabled, then try again.`,
      );
    }
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
  if (socketAppId !== botAppId)
    throw new Error(
      "The bot token and app token belong to different Slack apps. Copy both tokens from the same app; your existing connection has not changed.",
    );
  return {
    ...(auth.team_id ? { teamId: auth.team_id } : {}),
    ...(auth.team ? { teamName: auth.team } : {}),
  };
}
