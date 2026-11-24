import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import bolt from "@slack/bolt";
import type { App as BoltApp, Receiver, ReceiverEvent } from "@slack/bolt";
import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import {
  createDeferredEnvelopeAck,
  describeEnvelope,
  envelopeStageFor,
  isGatedEnvelope,
} from "../slack/deferred-ack.ts";
import type { EnvelopeStaging } from "../slack/envelope-staging.ts";
import { PayloadTooLargeError, readBody } from "../../plugins/chassis/src/http.ts";
import { errMessage } from "../util/errors.ts";
import { slackBotManifestCreationUrl } from "./slack-manifest.ts";
import { trimTrailingSlashes } from "../util/text.ts";

const { isValidSlackRequest } = bolt;

const MAX_BODY_BYTES = 5_000_000;
const PENDING_VERIFY_TTL_MS = 60_000;
const ROTATE_SKEW_MS = 5 * 60_000;
const CONFIG_TOKEN_KEY = "default";

interface StoredSlackConfigToken {
  accessTokenEnc: string;
  refreshTokenEnc?: string;
  expiresAt?: number;
  teamId?: string;
  updatedAt: number;
  updatedBy: string;
}

interface StoredPersonaSlackApp {
  personaId: string;
  status: "pending_install" | "connected";
  appId?: string;
  clientId?: string;
  clientSecretEnc?: string;
  signingSecretEnc: string;
  botTokenEnc?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  oauthAuthorizeUrl?: string;
  oauthStateEnc?: string;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

interface SlackConfigTokenStatus {
  configured: boolean;
  hasRefreshToken: boolean;
  teamId?: string;
  expiresAt?: number;
  updatedAt?: number;
  updatedBy?: string;
}

interface PersonaSlackApp {
  personaId: string;
  status: "pending_install" | "connected";
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  signingSecret: string;
  botToken?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  oauthAuthorizeUrl?: string;
  oauthState?: string;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

interface PersonaSlackStatus {
  status: "unconnected" | "pending_install" | "connected";
  appId?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  oauthAuthorizeUrl?: string;
  hasOrgConfigToken: boolean;
  publicUrlConfigured: boolean;
  manifestCreateUrl: string;
  updatedAt?: number;
  updatedBy?: string;
}

interface ManifestTemplate {
  display_information: { name: string; description: string; background_color?: string };
  features: { bot_user: { display_name: string; always_online?: boolean }; [k: string]: unknown };
  oauth_config: { redirect_urls?: string[]; scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url?: string; bot_events: string[] };
    interactivity?: { is_enabled: boolean; request_url?: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

let cachedTemplate: string | undefined;

function loadManifestTemplate(): ManifestTemplate {
  cachedTemplate ??= readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8");
  return JSON.parse(cachedTemplate) as ManifestTemplate;
}

function personaSlackEventsUrl(publicUrl: string, personaId: string): string {
  return `${trimTrailingSlashes(publicUrl)}/slack/events/persona/${encodeURIComponent(personaId)}`;
}

function personaSlackOAuthCallbackUrl(publicUrl: string, personaId: string): string {
  return `${trimTrailingSlashes(publicUrl)}/v1/personas/${encodeURIComponent(personaId)}/slack/oauth/callback`;
}

export function personaSlackManifest(opts: {
  personaId: string;
  name: string;
  description?: string;
  publicUrl: string;
  orgDeploy?: boolean;
}): ManifestTemplate {
  const manifest = loadManifestTemplate();
  const label = [...(opts.name.trim() || "Persona")].slice(0, 35).join("");
  const desc = [...(opts.description?.trim() || `${label} workspace agent`)].slice(0, 140).join("");
  const eventsUrl = personaSlackEventsUrl(opts.publicUrl, opts.personaId);
  const callbackUrl = personaSlackOAuthCallbackUrl(opts.publicUrl, opts.personaId);
  manifest.display_information.name = label;
  manifest.display_information.description = desc;
  manifest.features.bot_user.display_name = label;
  manifest.oauth_config.redirect_urls = [callbackUrl];
  manifest.settings.socket_mode_enabled = false;
  manifest.settings.org_deploy_enabled = Boolean(opts.orgDeploy);
  manifest.settings.event_subscriptions.request_url = eventsUrl;
  if (manifest.settings.interactivity) manifest.settings.interactivity.request_url = eventsUrl;
  return manifest;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  let payload = "";
  if (typeof body === "string") payload = body;
  else if (body !== undefined) payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function equalStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function slackJson(
  fetchImpl: typeof fetch,
  method: string,
  opts: { token?: string; json?: Record<string, unknown>; form?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack ${method} failed (HTTP ${res.status})`);
  return (await res.json()) as Record<string, unknown>;
}

export interface PersonaSlackStore {
  configTokenStatus(): Promise<SlackConfigTokenStatus>;
  setConfigToken(input: {
    accessToken?: string;
    refreshToken?: string;
    updatedBy: string;
  }): Promise<SlackConfigTokenStatus>;
  deleteConfigToken(): Promise<void>;
  get(personaId: string): Promise<PersonaSlackApp | null>;
  listConnected(): Promise<PersonaSlackApp[]>;
  status(persona: { id: string; name: string }): Promise<PersonaSlackStatus>;
  createApp(input: {
    persona: { id: string; name: string; description?: string };
    configToken?: string;
    refreshToken?: string;
    orgDeploy?: boolean;
    actorId: string;
  }): Promise<PersonaSlackStatus>;
  completeOAuth(personaId: string, code: string, state: string): Promise<PersonaSlackApp>;
  attachManual(input: {
    personaId: string;
    botToken: string;
    signingSecret: string;
    appId?: string;
    actorId: string;
  }): Promise<PersonaSlackApp>;
  disconnect(personaId: string, opts?: { deleteRemote?: boolean }): Promise<boolean>;
  receiver(personaId: string, staging?: EnvelopeStaging): Receiver;
  handleEvent(req: IncomingMessage, res: ServerResponse, personaId: string): Promise<void>;
  onChange(listener: () => void): void;
}

export function createPersonaSlackStore(opts: {
  appsMap: DurableMap<StoredPersonaSlackApp>;
  configTokenMap: DurableMap<StoredSlackConfigToken>;
  keyMaterial: Buffer | string;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
}): PersonaSlackStore {
  const key = deriveConnectorKey(opts.keyMaterial, "persona-slack");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const listeners: Array<() => void> = [];
  const notify = () => listeners.forEach((fn) => fn());

  type ActiveReceiver = { app: BoltApp; staging?: EnvelopeStaging };
  const activeReceivers = new Map<string, ActiveReceiver>();
  const pendingVerifications = new Map<string, number>();

  const hydrate = (stored: StoredPersonaSlackApp | null): PersonaSlackApp | null => {
    if (!stored) return null;
    return {
      personaId: stored.personaId,
      status: stored.status,
      ...(stored.appId ? { appId: stored.appId } : {}),
      ...(stored.clientId ? { clientId: stored.clientId } : {}),
      ...(stored.clientSecretEnc ? { clientSecret: decryptSecret(stored.clientSecretEnc, key) } : {}),
      signingSecret: decryptSecret(stored.signingSecretEnc, key),
      ...(stored.botTokenEnc ? { botToken: decryptSecret(stored.botTokenEnc, key) } : {}),
      ...(stored.botUserId ? { botUserId: stored.botUserId } : {}),
      ...(stored.teamId ? { teamId: stored.teamId } : {}),
      ...(stored.teamName ? { teamName: stored.teamName } : {}),
      ...(stored.oauthAuthorizeUrl ? { oauthAuthorizeUrl: stored.oauthAuthorizeUrl } : {}),
      ...(stored.oauthStateEnc ? { oauthState: decryptSecret(stored.oauthStateEnc, key) } : {}),
      version: stored.version,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  };

  async function rotateRefreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
    teamId?: string;
  }> {
    const data = await slackJson(fetchImpl, "tooling.tokens.rotate", { form: { refresh_token: refreshToken } });
    if (!data.ok || typeof data.token !== "string") {
      throw new Error(`Slack config token rotation failed: ${String(data.error ?? "unknown")}`);
    }
    return {
      accessToken: data.token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
      ...(typeof data.exp === "number" ? { expiresAt: data.exp * 1000 } : {}),
      ...(typeof data.team_id === "string" ? { teamId: data.team_id } : {}),
    };
  }

  async function resolveConfigToken(explicitAccess?: string, explicitRefresh?: string): Promise<string> {
    if (explicitRefresh?.trim()) {
      const rotated = await rotateRefreshToken(explicitRefresh.trim());
      return rotated.accessToken;
    }
    if (explicitAccess?.trim()) return explicitAccess.trim();
    const stored = await opts.configTokenMap.get(CONFIG_TOKEN_KEY);
    if (!stored) {
      throw new Error(
        "No workspace Slack App Configuration Token is saved. An org admin can generate one at https://api.slack.com/apps (Your App Configuration Tokens) and save it via PUT /v1/admin/slack-config-token.",
      );
    }
    const accessToken = decryptSecret(stored.accessTokenEnc, key);
    const refreshToken = stored.refreshTokenEnc ? decryptSecret(stored.refreshTokenEnc, key) : undefined;
    if (refreshToken && (!stored.expiresAt || Date.now() >= stored.expiresAt - ROTATE_SKEW_MS)) {
      const rotated = await rotateRefreshToken(refreshToken);
      await opts.configTokenMap.put(CONFIG_TOKEN_KEY, {
        accessTokenEnc: encryptSecret(rotated.accessToken, key),
        refreshTokenEnc: encryptSecret(rotated.refreshToken, key),
        ...(rotated.expiresAt ? { expiresAt: rotated.expiresAt } : {}),
        ...((rotated.teamId ?? stored.teamId) ? { teamId: rotated.teamId ?? stored.teamId } : {}),
        updatedAt: Date.now(),
        updatedBy: stored.updatedBy,
      });
      return rotated.accessToken;
    }
    return accessToken;
  }

  const publicStatusFor = async (
    persona: { id: string; name: string },
    record: StoredPersonaSlackApp | null,
  ): Promise<PersonaSlackStatus> => {
    const hasOrgConfigToken = Boolean(await opts.configTokenMap.get(CONFIG_TOKEN_KEY));
    const manifestCreateUrl = slackBotManifestCreationUrl(persona.name);
    const publicUrlConfigured = Boolean(opts.publicUrl);
    if (!record) {
      return { status: "unconnected", hasOrgConfigToken, publicUrlConfigured, manifestCreateUrl };
    }
    return {
      status: record.status,
      ...(record.appId ? { appId: record.appId } : {}),
      ...(record.botUserId ? { botUserId: record.botUserId } : {}),
      ...(record.teamId ? { teamId: record.teamId } : {}),
      ...(record.teamName ? { teamName: record.teamName } : {}),
      ...(record.status === "pending_install" && record.oauthAuthorizeUrl
        ? { oauthAuthorizeUrl: record.oauthAuthorizeUrl }
        : {}),
      hasOrgConfigToken,
      publicUrlConfigured,
      manifestCreateUrl,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  };

  return {
    async configTokenStatus(): Promise<SlackConfigTokenStatus> {
      const stored = await opts.configTokenMap.get(CONFIG_TOKEN_KEY);
      if (!stored) return { configured: false, hasRefreshToken: false };
      return {
        configured: true,
        hasRefreshToken: Boolean(stored.refreshTokenEnc),
        ...(stored.teamId ? { teamId: stored.teamId } : {}),
        ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy,
      };
    },

    async setConfigToken(input): Promise<SlackConfigTokenStatus> {
      const rawAccess = input.accessToken?.trim() ?? "";
      const rawRefresh = input.refreshToken?.trim() ?? "";
      if (!rawAccess && !rawRefresh) {
        throw new Error("Provide a Slack App Configuration refreshToken (xoxe-1-…) or accessToken (xoxe.xoxp-…).");
      }
      let accessToken = rawAccess;
      let refreshToken = rawRefresh || undefined;
      let expiresAt: number | undefined;
      let teamId: string | undefined;
      if (refreshToken) {
        const rotated = await rotateRefreshToken(refreshToken);
        accessToken = rotated.accessToken;
        refreshToken = rotated.refreshToken;
        expiresAt = rotated.expiresAt;
        teamId = rotated.teamId;
      } else if (!accessToken.startsWith("xoxe.")) {
        throw new Error("Slack App Configuration accessToken should start with xoxe.");
      }
      const record: StoredSlackConfigToken = {
        accessTokenEnc: encryptSecret(accessToken, key),
        ...(refreshToken ? { refreshTokenEnc: encryptSecret(refreshToken, key) } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(teamId ? { teamId } : {}),
        updatedAt: Date.now(),
        updatedBy: input.updatedBy,
      };
      await opts.configTokenMap.put(CONFIG_TOKEN_KEY, record);
      return this.configTokenStatus();
    },

    async deleteConfigToken(): Promise<void> {
      await opts.configTokenMap.delete(CONFIG_TOKEN_KEY);
    },

    async get(personaId: string): Promise<PersonaSlackApp | null> {
      return hydrate(await opts.appsMap.get(personaId));
    },

    async listConnected(): Promise<PersonaSlackApp[]> {
      const entries = await opts.appsMap.entries();
      const out: PersonaSlackApp[] = [];
      for (const [, stored] of entries) {
        if (stored.status !== "connected" || !stored.botTokenEnc) continue;
        const app = hydrate(stored);
        if (app?.botToken) out.push(app);
      }
      return out;
    },

    async status(persona: { id: string; name: string }): Promise<PersonaSlackStatus> {
      return publicStatusFor(persona, await opts.appsMap.get(persona.id));
    },

    async createApp(input): Promise<PersonaSlackStatus> {
      if (!opts.publicUrl) {
        throw new Error(
          "PUBLIC_WEB_URL is not configured on this instance. HTTP Events persona apps require a public URL; connect a manual app instead.",
        );
      }
      const token = await resolveConfigToken(input.configToken, input.refreshToken);
      const manifest = personaSlackManifest({
        personaId: input.persona.id,
        name: input.persona.name,
        ...(input.persona.description ? { description: input.persona.description } : {}),
        publicUrl: opts.publicUrl,
        ...(input.orgDeploy ? { orgDeploy: true } : {}),
      });
      const pending = pendingVerifications;
      pending.set(input.persona.id, Date.now() + PENDING_VERIFY_TTL_MS);
      let created: Record<string, unknown>;
      try {
        created = await slackJson(fetchImpl, "apps.manifest.create", { token, json: { manifest } });
      } finally {
        pending.delete(input.persona.id);
      }
      if (!created.ok) {
        const detail = Array.isArray(created.errors)
          ? created.errors.map((e) => (e as { message?: string }).message ?? JSON.stringify(e)).join("; ")
          : "";
        throw new Error(
          `Slack apps.manifest.create failed: ${String(created.error ?? "unknown")}${detail ? ` (${detail})` : ""}`,
        );
      }
      const appId = typeof created.app_id === "string" ? created.app_id : "";
      const creds = (created.credentials ?? {}) as Record<string, unknown>;
      const clientId = typeof creds.client_id === "string" ? creds.client_id : "";
      const clientSecret = typeof creds.client_secret === "string" ? creds.client_secret : "";
      const signingSecret = typeof creds.signing_secret === "string" ? creds.signing_secret : "";
      if (!appId || !clientId || !clientSecret || !signingSecret) {
        throw new Error("Slack apps.manifest.create did not return complete app credentials.");
      }
      const oauthState = randomBytes(24).toString("hex");
      const callbackUrl = personaSlackOAuthCallbackUrl(opts.publicUrl, input.persona.id);
      const authUrl = new URL("https://slack.com/oauth/v2/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("scope", manifest.oauth_config.scopes.bot.join(","));
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("state", oauthState);

      const record: StoredPersonaSlackApp = {
        personaId: input.persona.id,
        status: "pending_install",
        appId,
        clientId,
        clientSecretEnc: encryptSecret(clientSecret, key),
        signingSecretEnc: encryptSecret(signingSecret, key),
        oauthAuthorizeUrl: authUrl.toString(),
        oauthStateEnc: encryptSecret(oauthState, key),
        version: randomUUID(),
        updatedAt: Date.now(),
        updatedBy: input.actorId,
      };
      await opts.appsMap.put(input.persona.id, record);
      return publicStatusFor(input.persona, record);
    },

    async completeOAuth(personaId: string, code: string, state: string): Promise<PersonaSlackApp> {
      const stored = await opts.appsMap.get(personaId);
      const app = hydrate(stored);
      if (!stored || !app || !app.clientId || !app.clientSecret || !app.oauthState) {
        throw new Error("No pending Slack app installation found for this persona.");
      }
      if (!state || !equalStrings(state, app.oauthState)) {
        throw new Error("Invalid OAuth state for persona Slack installation.");
      }
      if (!opts.publicUrl) throw new Error("PUBLIC_WEB_URL is not configured.");
      const callbackUrl = personaSlackOAuthCallbackUrl(opts.publicUrl, personaId);
      const exchanged = await slackJson(fetchImpl, "oauth.v2.access", {
        form: {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code,
          redirect_uri: callbackUrl,
        },
      });
      if (!exchanged.ok || typeof exchanged.access_token !== "string") {
        throw new Error(`Slack OAuth exchange failed: ${String(exchanged.error ?? "unknown")}`);
      }
      const team = (exchanged.team ?? {}) as { id?: unknown; name?: unknown };
      const updated: StoredPersonaSlackApp = {
        personaId,
        status: "connected",
        ...(stored.appId ? { appId: stored.appId } : {}),
        ...(stored.clientId ? { clientId: stored.clientId } : {}),
        ...(stored.clientSecretEnc ? { clientSecretEnc: stored.clientSecretEnc } : {}),
        signingSecretEnc: stored.signingSecretEnc,
        botTokenEnc: encryptSecret(exchanged.access_token, key),
        ...(typeof exchanged.bot_user_id === "string" ? { botUserId: exchanged.bot_user_id } : {}),
        ...(typeof team.id === "string" ? { teamId: team.id } : {}),
        ...(typeof team.name === "string" ? { teamName: team.name } : {}),
        version: randomUUID(),
        updatedAt: Date.now(),
        updatedBy: stored.updatedBy,
      };
      await opts.appsMap.put(personaId, updated);
      notify();
      return hydrate(updated)!;
    },

    async attachManual(input): Promise<PersonaSlackApp> {
      const botToken = input.botToken.trim();
      const signingSecret = input.signingSecret.trim();
      if (!botToken.startsWith("xoxb-")) throw new Error("botToken must start with xoxb-");
      if (!signingSecret) throw new Error("signingSecret is required");
      const auth = await slackJson(fetchImpl, "auth.test", { token: botToken });
      if (!auth.ok) throw new Error(`Slack auth.test failed: ${String(auth.error ?? "invalid_auth")}`);
      const record: StoredPersonaSlackApp = {
        personaId: input.personaId,
        status: "connected",
        ...(input.appId?.trim() ? { appId: input.appId.trim() } : {}),
        signingSecretEnc: encryptSecret(signingSecret, key),
        botTokenEnc: encryptSecret(botToken, key),
        ...(typeof auth.user_id === "string" ? { botUserId: auth.user_id } : {}),
        ...(typeof auth.team_id === "string" ? { teamId: auth.team_id } : {}),
        ...(typeof auth.team === "string" ? { teamName: auth.team } : {}),
        version: randomUUID(),
        updatedAt: Date.now(),
        updatedBy: input.actorId,
      };
      await opts.appsMap.put(input.personaId, record);
      notify();
      return hydrate(record)!;
    },

    async disconnect(personaId: string, disconnectOpts): Promise<boolean> {
      const stored = await opts.appsMap.get(personaId);
      if (!stored) return false;
      if (disconnectOpts?.deleteRemote && stored.appId) {
        const token = await resolveConfigToken();
        const del = await slackJson(fetchImpl, "apps.manifest.delete", { token, json: { app_id: stored.appId } });
        if (!del.ok && del.error !== "app_not_found") {
          throw new Error(`Slack apps.manifest.delete failed: ${String(del.error ?? "unknown")}`);
        }
      }
      await opts.appsMap.delete(personaId);
      notify();
      return true;
    },

    receiver(personaId: string, staging?: EnvelopeStaging): Receiver {
      let instance: ActiveReceiver | undefined;
      const receivers = activeReceivers;
      return {
        init(app: BoltApp) {
          instance = { app, staging };
        },
        async start() {
          if (instance) receivers.set(personaId, instance);
        },
        async stop() {
          if (instance && receivers.get(personaId) === instance) receivers.delete(personaId);
        },
      } as Receiver;
    },

    async handleEvent(req: IncomingMessage, res: ServerResponse, personaId: string): Promise<void> {
      let raw: string;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        const large = error instanceof PayloadTooLargeError;
        return respond(res, large ? 413 : 400, { error: large ? "body_too_large" : "invalid_body" });
      }
      const app = await this.get(personaId);
      let body: Record<string, unknown>;
      try {
        const form = raw.startsWith("payload=") ? new URLSearchParams(raw).get("payload") : null;
        body = JSON.parse(form ?? raw) as Record<string, unknown>;
      } catch {
        return respond(res, 400, { error: "invalid_json" });
      }
      if (!app) {
        const pendingUntil = pendingVerifications.get(personaId);
        if (pendingUntil && Date.now() <= pendingUntil && body.type === "url_verification") {
          return respond(res, 200, { challenge: body.challenge });
        }
        return respond(res, 404, { error: "not_found" });
      }
      const signature = header(req, "x-slack-signature");
      const timestamp = Number(header(req, "x-slack-request-timestamp"));
      if (
        !signature ||
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > 5 * 60 ||
        !isValidSlackRequest({
          signingSecret: app.signingSecret,
          body: raw,
          headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
        })
      ) {
        return respond(res, 401, { error: "invalid_signature" });
      }
      if (body.type === "url_verification") return respond(res, 200, { challenge: body.challenge });

      const active = activeReceivers.get(personaId);
      if (!active) return respond(res, 503, { error: "persona_slack_not_ready" });

      const label = describeEnvelope(body);
      const { ack, gate } = createDeferredEnvelopeAck(async (response?: unknown) => respond(res, 200, response ?? {}), {
        gated: isGatedEnvelope(body),
        label,
        onWithhold: () => respond(res, 503, { error: "not_persisted" }),
        ...envelopeStageFor(active.staging, body),
      });
      const retryNum = Number(header(req, "x-slack-retry-num"));
      const event: ReceiverEvent = {
        body,
        ack,
        ...(Number.isFinite(retryNum) ? { retryNum } : {}),
        ...(header(req, "x-slack-retry-reason") ? { retryReason: header(req, "x-slack-retry-reason") } : {}),
        customProperties: { ackGate: gate },
      };
      try {
        await active.app.processEvent(event);
        gate.persisted();
      } catch (err) {
        gate.failed(errMessage(err));
      }
    },

    onChange(listener: () => void): void {
      listeners.push(listener);
    },
  };
}
